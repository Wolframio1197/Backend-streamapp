const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const multer = require('multer'); // Nuevo: para subir archivos
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. Conexión a Cosmos DB
mongoose.connect(process.env.COSMOS_CONNECTION_STRING)
  .then(() => console.log('Conectado a Cosmos DB'))
  .catch(err => console.error(err));

// 2. Crear el Modelo de Canción para la Base de Datos
const Song = mongoose.model('Song', new mongoose.Schema({
  fileName: String,
  originalName: String,
  uploadedAt: { type: Date, default: Date.now }
}));

// 3. Configurar Multer (Para recibir el archivo temporalmente)
const upload = multer({ dest: 'uploads/' }); // Guarda el archivo temporalmente en una carpeta

// 4. Configuración de Azure Blob Storage
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const containerName = 'canciones';
const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);

// Función para generar URL SAS (la misma de antes)
function getSasUrl(blobName) {
  const sasToken = generateBlobSASQueryParameters({
    containerName, blobName,
    permissions: BlobSASPermissions.parse("r"),
    startsOn: new Date(),
    expiresOn: new Date(new Date().valueOf() + 3600 * 1000),
  }, sharedKeyCredential).toString();
  return `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;
}

// ==========================================
// RUTAS DE LA API
// ==========================================

// Ruta ANTIGUA (la mantenemos por si la llamas por ahí)
app.get('/api/song/:songName', async (req, res) => {
  res.json({ url: getSasUrl(req.params.songName) });
});

// Ruta NUEVA: Obtener TODAS las canciones de la BD
app.get('/api/songs', async (req, res) => {
  const songs = await Song.find().sort({ uploadedAt: -1 }); // Ordenadas por las más nuevas
  // A cada canción le generamos su URL segura para escucharla
  const songsWithUrls = songs.map(song => ({
    id: song._id,
    name: song.originalName,
    url: getSasUrl(song.fileName)
  }));
  res.json(songsWithUrls);
});

// Ruta NUEVA: Subir una canción nueva
app.post('/api/upload', upload.single('audioFile'), async (req, res) => {
  if (!req.file) return res.status(400).send("No se subió ningún archivo");

  const file = req.file;
  // Generamos un nombre único para evitar que se pisen (ej: 12345.mp3)
  const blobName = Date.now() + path.extname(file.originalname);

  try {
    // 1. Subir a Azure Blob Storage
    const blockBlobClient = blobServiceClient.getContainerClient(containerName).getBlockBlobClient(blobName);
    await blockBlobClient.uploadFile(file.path);

    // 2. Guardar en Cosmos DB
    const newSong = new Song({
      fileName: blobName,
      originalName: file.originalname // El nombre bonito que ve el usuario
    });
    await newSong.save();

    // 3. Eliminar el archivo temporal de la carpeta 'uploads/' del servidor
    const fs = require('fs');
    fs.unlinkSync(file.path);

    // 4. Devolver la lista actualizada
    const songs = await Song.find().sort({ uploadedAt: -1 });
    const songsWithUrls = songs.map(song => ({
      id: song._id,
      name: song.originalName,
      url: getSasUrl(song.fileName)
    }));

    res.json(songsWithUrls);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error al subir la canción");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT}`));