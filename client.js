document.addEventListener('DOMContentLoaded', () => {
    const companySelect = document.getElementById('company');
    const fileList = document.getElementById('fileList');

    async function fetchFiles() {
        const company = companySelect.value;
        if (!company) {
            fileList.innerHTML = '<p>Please select a company to view files.</p>';
            return;
        }
        try {
            const response = await fetch(`/client/files?company=${encodeURIComponent(company)}`);
            const data = await response.json();
            if (data.error) {
                fileList.innerHTML = `<p>Error: ${data.error}</p>`;
                return;
            }
            fileList.innerHTML = data.files.length ? 
                '<ul>' + data.files.map(file => `
                    <li>
                        File: ${file.fileName}<br>
                        Status: ${file.status}<br>
                        In Database: ${file.inDynamoDB ? 'Yes' : 'No'}
                    </li>`).join('') + '</ul>' : 
                '<p>No files found for this company.</p>';
        } catch (err) {
            fileList.innerHTML = '<p>Error fetching files.</p>';
            console.error('Fetch error:', err);
        }
    }

    companySelect.addEventListener('change', fetchFiles);
    fetchFiles();
});