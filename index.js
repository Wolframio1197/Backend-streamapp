const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');
const multer = require('multer'); // Nuevo: para subir archivos
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
  // Guardamos un resumen de la canción para evitar usar populate()
  songs: [{ songId: String, originalName: String, fileName: String }] 
}));

// 3. Configurar Multer (Para recibir el archivo temporalmente)
// Usamos os.tmpdir() para usar la carpeta temporal de Azure, donde SÍ tenemos permisos
const upload = multer({ dest: os.tmpdir() }); 


const containerName = 'canciones';

// 4. Configuración de Azure Blob Storage (Protegida)
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
  if (!sharedKeyCredential) return null; // Si no hay credenciales, devuelve nulo
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

// Ruta ANTIGUA (la mantenemos por si la llamas por ahí)
app.get('/api/song/:songName', async (req, res) => {
  res.json({ url: getSasUrl(req.params.songName) });
});

// Ruta NUEVA: Obtener TODAS las canciones de la BD
app.get('/api/songs', async (req, res) => {
    // Cambiar a _id: -1
  const songs = await Song.find().sort({ _id: -1 });   // Ordenadas por las más nuevas
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

// Ruta NUEVA: Borrar una canción
app.delete('/api/songs/:id', async (req, res) => {
  try {
    // 1. Buscar la canción en la base de datos para saber su nombre de archivo
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).send("Canción no encontrada en la BD");

    // 2. Borrar el archivo físico de Azure Blob Storage
    try {
      const blockBlobClient = blobServiceClient.getContainerClient(containerName).getBlockBlobClient(song.fileName);
      await blockBlobClient.delete(); // Lo elimina del contenedor 'canciones'
    } catch (blobError) {
      console.error("El archivo no existía en Blob Storage, pero continuamos:", blobError.message);
    }

    // 3. Borrar el registro de la base de datos
    await Song.findByIdAndDelete(req.params.id);

    // 4. Devolver la lista actualizada para que el Frontend se refresque sin recargar
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

// Obtener todas las playlists (filtradas por el email del usuario)
app.get('/api/playlists', async (req, res) => {
  const ownerEmail = req.query.owner;
  const playlists = await Playlist.find({ ownerEmail }).sort({ _id: -1 });
  
  // A cada canción dentro de cada playlist, le generamos su URL segura
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

// Crear una playlist nueva
app.post('/api/playlists', async (req, res) => {
  const { name, ownerEmail } = req.body;
  if (!name) return res.status(400).send("El nombre es obligatorio");
  
  const newPlaylist = new Playlist({ name, ownerEmail, songs: [] });
  await newPlaylist.save();
  res.status(201).json({ id: newPlaylist._id, name: newPlaylist.name, songs: [] });
});

// Añadir una canción a una playlist
app.post('/api/playlists/:id/song', async (req, res) => {
  const { songId, originalName, fileName } = req.body;
  const playlist = await Playlist.findById(req.params.id);
  if (!playlist) return res.status(404).send("Playlist no encontrada");

  // Evitamos añadir la misma canción dos veces
  if (playlist.songs.some(s => s.songId === songId)) {
    return res.json(playlist); // Devolvemos la tal cual
  }

  playlist.songs.push({ songId, originalName, fileName });
  await playlist.save();
  res.json(playlist);
});

// Quitar una canción de una playlist
app.delete('/api/playlists/:id/song/:songId', async (req, res) => {
  const playlist = await Playlist.findById(req.params.id);
  if (!playlist) return res.status(404).send("Playlist no encontrada");

  playlist.songs = playlist.songs.filter(s => s.songId !== req.params.songId);
  await playlist.save();
  res.json(playlist);
});

// Ruta NUEVA: Borrar una playlist entera
app.delete('/api/playlists/:id', async (req, res) => {
  try {
    await Playlist.findByIdAndDelete(req.params.id);
    res.status(204).send(); // 204 significa "Borrado con éxito sin devolver contenido"
  } catch (error) {
    console.error(error);
    res.status(500).send("Error al borrar la playlist");
  }
});
const Favorite = mongoose.model('Favorite', new mongoose.Schema({
  userId: String,       // El ID de Microsoft del usuario
  songId: String,
  originalName: String,
  fileName: String
}));
// ==========================================
// RUTAS DE FAVORITOS
// ==========================================

// Obtener TODOS los favoritos de un usuario
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

// Añadir a favoritos
app.post('/api/favorites', async (req, res) => {
  const { userId, songId, originalName, fileName } = req.body;
  if (!userId || !songId) return res.status(400).send("Faltan datos");

  // Evitar duplicados
  const exists = await Favorite.findOne({ userId, songId });
  if (exists) return res.json({ message: "Ya es favorito" });

  const newFav = new Favorite({ userId, songId, originalName, fileName });
  await newFav.save();
  res.status(201).json({ message: "Añadido a favoritos" });
});

// Quitar de favoritos
app.delete('/api/favorites/:songId', async (req, res) => {
  const userId = req.query.userId;
  await Favorite.findOneAndDelete({ userId, songId: req.params.songId });
  res.status(204).send();
});

// Comprobar si una canción ES favorita (para pintar el corazón rojo al cargar la página)
app.get('/api/favorites/check/:songId', async (req, res) => {
  const userId = req.query.userId;
  const isFavorite = await Favorite.exists({ userId, songId: req.params.songId });
  res.json({ isFavorite: !!isFavorite });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT}`));