const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- SECURE CREDENTIALS LOADING FOR CLOUD DEPLOYMENT ---
let credentials;
// First, try to load from environment variables (for AWS/Render)
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    console.log("Loading credentials from environment variables...");
    credentials = {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        // In cloud environments, the private key may have its newlines escaped.
        // We replace the escaped newlines with actual newlines.
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
} 
// Otherwise, fall back to the local file (for local development)
else {
    console.log("Loading credentials from local credentials.json file...");
    const credentialsPath = path.join(__dirname, 'credentials.json');
    try {
        credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    } catch (e) {
        console.error("❌ Error: Cannot find credentials.json and environment variables are not set.");
        process.exit(1);
    }
}
// --- END OF SECURE LOADING ---


// חיבור ל-Drive
const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
});

const drive = google.drive({ version: 'v3', auth });
const FOLDER_ID = process.env.DRIVE_FOLDER_ID;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

// 1. קבלת רשימת התמונות
app.get('/api/images', async (req, res) => {
    try {
        const foldersResponse = await drive.files.list({
            q: `'${FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id, name)',
        });

        const folderIds = [FOLDER_ID, ...foldersResponse.data.files.map(f => f.id)];
        const parentsQuery = folderIds.map(id => `'${id}' in parents`).join(' or ');
        const query = `(${parentsQuery}) and mimeType contains 'image/' and trashed = false`;

        const imagesResponse = await drive.files.list({
            q: query,
            fields: 'files(id, name)',
            pageSize: 200
        });

        console.log(`--- Found ${imagesResponse.data.files.length} images ---`);
        res.json(imagesResponse.data.files);
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).send('Error fetching list');
    }
});

// 2. מנוע פרוקסי לתמונות ממוזערות
app.get('/api/thumb/:id', async (req, res) => {
    try {
        const fileId = req.params.id;
        const file = await drive.files.get({ fileId, fields: 'thumbnailLink' });

        if (file.data.thumbnailLink) {
            const thumbUrl = file.data.thumbnailLink.replace(/=s\d+/, '=s600');
            const fetchResponse = await fetch(thumbUrl);
            if (!fetchResponse.ok) throw new Error('Google blocked fetch');

            const arrayBuffer = await fetchResponse.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.send(buffer);
        } else {
            res.status(404).send('No thumbnail');
        }
    } catch (error) {
        res.status(500).send('Error generating thumb');
    }
});

// 3. הזרמת התמונה המלאה לצפייה בגדול (Lightbox)
app.get('/api/full/:id', async (req, res) => {
    try {
        const response = await drive.files.get({ fileId: req.params.id, alt: 'media' }, { responseType: 'stream' });
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send('Error loading full image');
    }
});

// 4. הזרמת התמונה להורדה ישירה
app.get('/api/download/:id', async (req, res) => {
    try {
        const response = await drive.files.get({ fileId: req.params.id, alt: 'media' }, { responseType: 'stream' });
        res.setHeader('Content-Disposition', 'attachment');
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send('Error downloading file');
    }
});

// 5. ראוט חדש: אריזת תמונות מסומנות ל-ZIP והורדה - שימוש בספרייה JSZip במקום archiver המרדנית
app.post('/api/download-zip', async (req, res) => {
    try {
        const ids = req.body.ids ? req.body.ids.split(',') : [];
        if (ids.length === 0) return res.status(400).send('No images selected');

        console.log(`\n📦 Starting ZIP creation for ${ids.length} images...`);

        // שימוש ב-jszip שבדרך כלל עובד הרבה יותר טוב בסביבות Node נטולות תוספים מורכבים
        const JSZip = require('jszip');
        const zip = new JSZip();

        for (let i = 0; i < ids.length; i++) {
            try {
                console.log(`Fetching image ${i + 1}/${ids.length} (ID: ${ids[i]})`);
                
                // כאן אנחנו מורידים כ-ArrayBuffer כי JSZip יודע לעבוד איתו מושלם
                const response = await drive.files.get(
                    { fileId: ids[i], alt: 'media' },
                    { responseType: 'arraybuffer' }
                );

                // מוסיפים את התמונה ל-ZIP בזיכרון
                zip.file(`Wedding_Photo_${i+1}.jpg`, response.data);
                console.log(`✅ Image ${i + 1} added to ZIP`);

            } catch (err) {
                console.error(`❌ Error fetching file ${ids[i]} for ZIP:`, err.message);
            }
        }

        console.log('✅ Finalizing ZIP...');
        
        // מגדיר לדפדפן שמדובר בקובץ להורדה
        res.setHeader('Content-Type', 'application/zip');
        res.attachment('Gal_And_Shoval_Wedding_Collection.zip');
        
        // הופך את ה-ZIP לזרם נתונים ויורה אותו ישירות ללקוח
        zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true })
           .pipe(res)
           .on('finish', function () {
               console.log('🎉 ZIP successfully finalized and sent.');
           });

    } catch (error) {
        console.error('General ZIP Error:', error);
        if (!res.headersSent) res.status(500).send('Error creating zip');
    }
});

app.listen(PORT, () => console.log(`🚀 Server running smoothly on port ${PORT}`));