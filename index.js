const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const multer = require('multer');
const path = require('path');
const os = require('os'); 
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

// Modelo de Lista de Reproducción
const Playlist = mongoose.model('Playlist', new mongoose.Schema({
  name: String,
  ownerEmail: String,
  songs: [{ songId: String, originalName: String, fileName: String }] 
}));

// 3. Configurar Multer
const upload = multer({ dest: os.tmpdir() }); 

const containerName = 'canciones';

// 4. Configuración de Azure Blob Storage
let blobServiceClient, sharedKeyCredential;

try {
  blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
  sharedKeyCredential = new StorageSharedKeyCredential(
    process.env.AZURE_STORAGE_ACCOUNT_NAME, 
    process.env.AZURE_STORAGE_ACCOUNT_KEY
  );
} catch (error) {
  console.error("ERROR CRÍTICO: Faltan las variables de entorno del Blob Storage en Azure App Service", error.message);
}

// Función para generar URL SAS
function getSasUrl(blobName) {
  if (!sharedKeyCredential) return null; 
  const sasToken = generateBlobSASQueryParameters({
    containerName, blobName,
    permissions: BlobSASPermissions.parse("r"),
    startsOn: new Date(),
    expiresOn: new Date(new Date().valueOf() + 3600 * 1000),
  }, sharedKeyCredential).toString();
  return `https://${process.env.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;
}

// ==========================================
// RUTAS DE LA API
// ==========================================

app.get('/api/song/:songName', async (req, res) => {
  res.json({ url: getSasUrl(req.params.songName) });
});

app.get('/api/songs', async (req, res) => {
  const songs = await Song.find().sort({ _id: -1 });   
  const songsWithUrls = songs.map(song => ({
    id: song._id,
    name: song.originalName,
    url: getSasUrl(song.fileName)
  }));
  res.json(songsWithUrls);
});

app.post('/api/upload', upload.single('audioFile'), async (req, res) => {
  if (!req.file) return res.status(400).send("No se subió ningún archivo");

  const file = req.file;
  const blobName = Date.now() + path.extname(file.originalname);

  try {
    const blockBlobClient = blobServiceClient.getContainerClient(containerName).getBlockBlobClient(blobName);
    await blockBlobClient.uploadFile(file.path);

    const newSong = new Song({
      fileName: blobName,
      originalName: file.originalname
    });
    await newSong.save();

    const fs = require('fs');
    fs.unlinkSync(file.path);

    const songs = await Song.find().sort({ _id: -1 });  
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

app.delete('/api/songs/:id', async (req, res) => {
  try {
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).send("Canción no encontrada en la BD");

    try {
      const blockBlobClient = blobServiceClient.getContainerClient(containerName).getBlockBlobClient(song.fileName);
      await blockBlobClient.delete(); 
    } catch (blobError) {
      console.error("El archivo no existía en Blob Storage, pero continuamos:", blobError.message);
    }

    await Song.findByIdAndDelete(req.params.id);

    const songs = await Song.find().sort({ _id: -1 }); 
    const songsWithUrls = songs.map(s => ({
      id: s._id,
      name: s.originalName,
      url: getSasUrl(s.fileName)
    }));

    res.json(songsWithUrls);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error al borrar la canción");
  }
});

// ==========================================
// RUTAS DE PLAYLISTS
// ==========================================

app.get('/api/playlists', async (req, res) => {
  const ownerEmail = req.query.owner;
  const playlists = await Playlist.find({ ownerEmail }).sort({ _id: -1 });
  
  const playlistsWithUrls = playlists.map(pl => ({
    id: pl._id,
    name: pl.name,
    songs: pl.songs.map(s => ({
      id: s.songId,
      name: s.originalName,
      url: getSasUrl(s.fileName)
    }))
  }));
  res.json(playlistsWithUrls);
});

app.post('/api/playlists', async (req, res) => {
  const { name, ownerEmail } = req.body;
  if (!name) return res.status(400).send("El nombre es obligatorio");
  
  const newPlaylist = new Playlist({ name, ownerEmail, songs: [] });
  await newPlaylist.save();
  res.status(201).json({ id: newPlaylist._id, name: newPlaylist.name, songs: [] });
});

app.post('/api/playlists/:id/song', async (req, res) => {
  const { songId, originalName, fileName } = req.body;
  const playlist = await Playlist.findById(req.params.id);
  if (!playlist) return res.status(404).send("Playlist no encontrada");

  if (playlist.songs.some(s => s.songId === songId)) {
    return res.json(playlist); 
  }

  playlist.songs.push({ songId, originalName, fileName });
  await playlist.save();
  res.json(playlist);
});

app.delete('/api/playlists/:id/song/:songId', async (req, res) => {
  const playlist = await Playlist.findById(req.params.id);
  if (!playlist) return res.status(404).send("Playlist no encontrada");

  playlist.songs = playlist.songs.filter(s => s.songId !== req.params.songId);
  await playlist.save();
  res.json(playlist);
});

app.delete('/api/playlists/:id', async (req, res) => {
  try {
    await Playlist.findByIdAndDelete(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error(error);
    res.status(500).send("Error al borrar la playlist");
  }
});

// ==========================================
// RUTAS DE FAVORITOS
// ==========================================

// MODELO ACTUALIZADO: Ahora guarda también el nombre del usuario
const Favorite = mongoose.model('Favorite', new mongoose.Schema({
  userId: String,       
  userName: String,     // NUEVO: Para saber de quién es el favorito en el feed público
  songId: String,
  originalName: String,
  fileName: String
}));

// NUEVA RUTA: Feed Público (Explorar) - Obtiene los favoritos de TODOS
app.get('/api/favorites/explore', async (req, res) => {
  try {
    // Obtenemos los últimos 50 favoritos subidos por cualquier persona
    const favorites = await Favorite.find().sort({ _id: -1 }).limit(50);
    
    const favoritesWithUrls = favorites.map(f => ({
      userId: f.userId,
      userName: f.userName || 'Usuario Anónimo', // Por si hay registros antiguos sin nombre
      songId: f.songId,
      name: f.originalName,
      url: getSasUrl(f.fileName)
    }));
    res.json(favoritesWithUrls);
  } catch (error) {
    res.status(500).send("Error al cargar el feed público");
  }
});

// Obtener LOS favoritos DE UN usuario específico (el que está logueado)
app.get('/api/favorites', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).send("Falta el ID de usuario");
  
  const favorites = await Favorite.find({ userId }).sort({ _id: -1 });
  const favoritesWithUrls = favorites.map(f => ({
    id: f.songId,
    name: f.originalName,
    url: getSasUrl(f.fileName)
  }));
  res.json(favoritesWithUrls);
});

// Añadir a favoritos (ACTUALIZADO: ahora recibe el userName del frontend)
app.post('/api/favorites', async (req, res) => {
  const { userId, userName, songId, originalName, fileName } = req.body;
  if (!userId || !songId) return res.status(400).send("Faltan datos");

  // Evitar duplicados
  const exists = await Favorite.findOne({ userId, songId });
  if (exists) return res.json({ message: "Ya es favorito" });

  const newFav = new Favorite({ userId, userName, songId, originalName, fileName }); // Guardamos el userName
  await newFav.save();
  res.status(201).json({ message: "Añadido a favoritos" });
});

// Quitar de favoritos
app.delete('/api/favorites/:songId', async (req, res) => {
  const userId = req.query.userId;
  await Favorite.findOneAndDelete({ userId, songId: req.params.songId });
  res.status(204).send();
});

// Comprobar si una canción ES favorita
app.get('/api/favorites/check/:songId', async (req, res) => {
  const userId = req.query.userId;
  const isFavorite = await Favorite.exists({ userId, songId: req.params.songId });
  res.json({ isFavorite: !!isFavorite });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT}`));