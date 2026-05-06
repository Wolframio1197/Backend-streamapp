const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. Conexión a Cosmos DB (MongoDB)
mongoose.connect(process.env.COSMOS_CONNECTION_STRING)
  .then(() => console.log('Conectado a Cosmos DB'))
  .catch(err => console.error(err));

// 2. Configuración de Azure Blob Storage
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const containerName = 'canciones';
const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME; // Necesitas añadir esto al .env
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;   // Necesitas añadir esto al .env

// Ruta para obtener una URL segura de la canción
app.get('/api/song/:songName', async (req, res) => {
    const blobName = req.params.songName; // ej. cancion1.mp3
    
    const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
    
    // Generar token SAS válido por 1 hora
    const sasToken = generateBlobSASQueryParameters({
        containerName,
        blobName,
        permissions: BlobSASPermissions.parse("r"), // "r" = solo lectura
        startsOn: new Date(),
        expiresOn: new Date(new Date().valueOf() + 3600 * 1000), // 1 hora
    }, sharedKeyCredential).toString();

    const sasUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;
    res.json({ url: sasUrl });
});

app.listen(process.env.PORT, () => console.log('Backend corriendo en puerto 3000'));