require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Issuer, generators } = require('openid-client');
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(express.static('public'));

const s3Client = new S3Client({ region: 'eu-central-1' });
const dynamoDBClient = new DynamoDBClient({ region: 'eu-central-1' });
const docClient = DynamoDBDocumentClient.from(dynamoDBClient);

const upload = multer({ storage: multer.memoryStorage() });

let client;
async function initializeClient() {
    try {
        const issuer = await Issuer.discover('https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_EcAx5umNr');
        client = new issuer.Client({
            client_id: '1fo5iuk309tde5stb1oki2mur9',
            client_secret: process.env.COGNITO_CLIENT_SECRET || '17769k8e8gtfitqa1mv50fjb61nho2s3ql3t1vnnt635fijfrfe0', 
            redirect_uris: ['http://localhost:3000/callback'],
            response_types: ['code']
        });
        console.log('OpenID Client initialized successfully');
    } catch (error) {
        console.error('Error initializing OpenID Client:', error);
    }
}
initializeClient().catch(console.error);


app.use(session({
    secret: process.env.SESSION_SECRET || 'a9f7b3c8e2d4f6a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } 
}));


const checkAuth = (req, res, next) => {
    req.isAuthenticated = !!(req.session.userInfo && req.session.userInfo.email);
    next();
};


app.get('/', checkAuth, (req, res) => {
    const message = req.query.message || '';
    res.render('home', {
        isAuthenticated: req.isAuthenticated,
        userInfo: req.session.userInfo || {},
        message
    });
});

app.get('/login', (req, res) => {
    if (!client) {
        return res.status(500).send('Authentication service unavailable');
    }
    const nonce = generators.nonce();
    const state = generators.state();
    req.session.nonce = nonce;
    req.session.state = state;

    const authUrl = client.authorizationUrl({
        scope: 'email openid profile',
        state,
        nonce
    });
    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    try {
        const params = client.callbackParams(req);
        const tokenSet = await client.callback('http://localhost:3000/callback', params, {
            state: req.session.state,
            nonce: req.session.nonce
        });
        const userInfo = await client.userinfo(tokenSet.access_token);
        req.session.userInfo = userInfo;

        const idToken = tokenSet.id_token;
        const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString());
        const groups = payload['cognito:groups'] || [];
        req.session.userInfo.isAdmin = groups.some(group => group.toLowerCase() === 'admin');

        res.redirect(req.session.userInfo.isAdmin ? '/admin' : '/client');
    } catch (err) {
        console.error('Callback error:', err);
        res.redirect('/?message=Authentication failed');
    }
});

app.get('/admin', checkAuth, async (req, res) => {
    if (!req.isAuthenticated || !req.session.userInfo.isAdmin) {
        return res.redirect('/?message=Access denied');
    }
    try {
        const companyData = await docClient.send(new ScanCommand({ TableName: 'Companies' }));
        const companies = companyData.Items.map(item => item.companyId);

        const uploadData = await docClient.send(new ScanCommand({
            TableName: 'LogisticsData',
            FilterExpression: '#type = :type',
            ExpressionAttributeNames: { '#type': 'type' },
            ExpressionAttributeValues: { ':type': 'upload' },
            Limit: 10
        }));
        const uploads = uploadData.Items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.render('admin', {
            userInfo: req.session.userInfo,
            message: req.query.message || '',
            companies,
            uploads
        });
    } catch (err) {
        console.error('Error fetching data:', err);
        res.render('admin', {
            userInfo: req.session.userInfo,
            message: req.query.message || 'Error fetching data',
            companies: [],
            uploads: []
        });
    }
});

app.post('/admin/add-company', checkAuth, async (req, res) => {
    if (!req.isAuthenticated || !req.session.userInfo.isAdmin) {
        return res.redirect('/?message=Access denied');
    }
    const { companyName } = req.body;
    if (!companyName) {
        return res.redirect('/admin?message=Please provide a company name');
    }
    const sanitizedCompany = companyName.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
    if (!sanitizedCompany) {
        return res.redirect('/admin?message=Invalid company name');
    }
    try {
        await docClient.send(new PutCommand({
            TableName: 'Companies',
            Item: {
                companyId: sanitizedCompany,
                companyName,
                createdAt: new Date().toISOString()
            },
            ConditionExpression: 'attribute_not_exists(companyId)'
        }));
        res.redirect(`/admin?message=Company ${sanitizedCompany} added successfully`);
    } catch (err) {
        console.error('Error adding company:', err);
        res.redirect(`/admin?message=${err.code === 'ConditionalCheckFailedException' ? 'Company already exists' : 'Error adding company'}`);
    }
});

app.get('/client', checkAuth, async (req, res) => {
    if (!req.isAuthenticated || req.session.userInfo.isAdmin) {
        return res.redirect('/?message=Access denied');
    }
    try {
        const companyData = await docClient.send(new ScanCommand({ TableName: 'Companies' }));
        const companies = companyData.Items.map(item => ({
            companyId: item.companyId,
            companyName: item.companyName
        }));
        res.render('client', {
            userInfo: req.session.userInfo,
            companies,
            message: req.query.message || ''
        });
    } catch (err) {
        console.error('Error fetching companies:', err);
        res.render('client', {
            userInfo: req.session.userInfo,
            companies: [],
            message: req.query.message || 'Error fetching companies'
        });
    }
});

app.get('/client/files', checkAuth, async (req, res) => {
    if (!req.isAuthenticated || req.session.userInfo.isAdmin) {
        return res.status(403).json({ error: 'Access denied' });
    }
    const { company } = req.query;
    if (!company) {
        return res.status(400).json({ error: 'Company parameter is required' });
    }
    const sanitizedCompany = company.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
    try {
        const s3Data = await s3Client.send(new ListObjectsV2Command({
            Bucket: 'xyz-logistics-files',
            Prefix: `uploads/${sanitizedCompany}/`
        }));
        const dynamoData = await docClient.send(new ScanCommand({
            TableName: 'LogisticsData',
            FilterExpression: 'companyId = :company',
            ExpressionAttributeValues: { ':company': sanitizedCompany }
        }));
        const files = (s3Data.Contents || []).map(file => ({
            key: file.Key,
            fileName: file.Key.split('/').pop(),
            inDynamoDB: dynamoData.Items.some(item => item.S3Key === file.Key),
            status: dynamoData.Items.find(item => item.S3Key === file.Key)?.status || 'pending'
        }));
        res.json({ files });
    } catch (err) {
        console.error('Error fetching files:', err);
        res.status(500).json({ error: 'Error fetching files' });
    }
});

app.post('/upload', checkAuth, upload.single('excelFile'), async (req, res) => {
    if (!req.isAuthenticated || req.session.userInfo.isAdmin) {
        return res.redirect('/?message=Access denied');
    }
    const { company } = req.body;
    if (!company) {
        return res.redirect('/client?message=Please select a company');
    }
    const sanitizedCompany = company.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
    try {
        const companyCheck = await docClient.send(new GetCommand({
            TableName: 'Companies',
            Key: { companyId: sanitizedCompany }
        }));
        if (!companyCheck.Item) {
            return res.redirect('/client?message=Selected company does not exist');
        }
        const file = req.file;
        if (!file) {
            return res.redirect('/client?message=Please select an Excel file');
        }
        const fileId = uuidv4();
        const fileKey = `uploads/${sanitizedCompany}/${fileId}-${file.originalname}`;
        await s3Client.send(new PutObjectCommand({
            Bucket: 'xyz-logistics-files',
            Key: fileKey,
            Body: file.buffer,
            ContentType: file.mimetype
        }));
        const timestamp = new Date().toISOString();
        await docClient.send(new PutCommand({
            TableName: 'LogisticsData',
            Item: {
                fileId,
                type: 'upload',
                timestamp,
                companyId: sanitizedCompany,
                S3Key: fileKey,
                data: file.originalname,
                uploadedBy: req.session.userInfo.email,
                status: 'pending'
            }
        }));
        
        res.redirect(`/client?message=File uploaded successfully for ${sanitizedCompany} with FileID ${fileId}`);
    } catch (err) {
        console.error('Error during upload:', err);
        res.redirect('/client?message=Error uploading file');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Session destroy error:', err);
            return res.redirect('/?message=Logout failed');
        }
        const logoutUrl = `https://eu-central-1ecax5umnr.auth.eu-central-1.amazoncognito.com/logout?client_id=1fo5iuk309tde5stb1oki2mur9&logout_uri=http://localhost:3000`;
        res.redirect(logoutUrl);
    });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));