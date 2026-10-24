require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { mongoose, ensureConnection } = require('./src/config/mongo');
// Old -> new values for update requests (Activity Log). Must load before any model.
require('./src/helper/changeLog').install();
const app = express();
const port = process.env.PORT || 4000;
const allRoutes = require('./src/routes/allRoutes');
const auditLogger = require('./src/middleware/auditLogger');

const dashboardRoutes = require('./src/routes/dashboardRoutes');

// CORS: allow frontend to access backend
// FRONTEND_ORIGIN may list several sites, comma separated.
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);
app.use(cors({
  origin: [...FRONTEND_ORIGINS, 'http://localhost:3000', 'http://localhost:3001', 'https://www.hamzamobile.com'],
  credentials: true,
}));

// Parse JSON (but not for webhook endpoint)
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payment/webhook') {
    next();
  } else {
    express.json({ limit: '50mb' })(req, res, next);
  }
});

// Also add urlencoded parser for form data
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded files statically (must match path in helper/upload.js)
app.use('/uploads', express.static(path.resolve(__dirname, 'uploads')));

// Middleware to ensure MongoDB connection for serverless environments
app.use('/api', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
});


// Dashboard routes (authentication required)
app.use('/dashboard', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
}, dashboardRoutes);

// Add the same middleware for other routes that need database
app.use('/', async (req, res, next) => {
  // Skip for static routes and non-database routes
  if (req.path.startsWith('/uploads') || req.path === '/' || req.path === '/health') {
    return next();
  }
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
});

// Welcome route
app.get('/', (req, res) => {
  try {
    const mongoose = require('mongoose');

    res.json({
      message: 'Welcome to Mirpur Mobile & Stationery API',
      status: 'running',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      database: {
        status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        readyState: mongoose.connection.readyState
      },
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    console.error('Error in welcome route:', error);
    res.status(500).json({
      message: 'Welcome to Mirpur Mobile & Stationery API',
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    const mongoose = require('mongoose');
    const isDbConnected = mongoose.connection.readyState === 1;

    res.status(isDbConnected ? 200 : 503).json({
      status: isDbConnected ? 'healthy' : 'unhealthy',
      database: {
        status: isDbConnected ? 'connected' : 'disconnected',
        readyState: mongoose.connection.readyState
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Protected routes (authentication required for most)
app.use('/', async (req, res, next) => {
  try {
    await ensureConnection();
    next();
  } catch (error) {
    console.error('Failed to ensure MongoDB connection:', error);
    res.status(503).json({
      error: 'Database connection failed',
      message: 'Please try again in a moment'
    });
  }
}, auditLogger, allRoutes);

// Global error handler for Multer and other errors
app.use((error, req, res, next) => {
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ 
      error: 'File too large', 
      message: `File size exceeds the maximum limit of ${process.env.UPLOAD_MAX_FILE_SIZE_MB || 5}MB` 
    });
  }
  
  if (error.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ 
      error: 'Too many files', 
      message: 'Number of files exceeds the maximum allowed. Maximum 10 banner images are allowed.' 
    });
  }
  
  if (error.name === 'MulterError') {
    return res.status(400).json({ 
      error: 'Upload error', 
      message: error.message 
    });
  }
  
  // Default error handler
  console.error(error);
  res.status(500).json({ 
    error: 'Internal server error', 
    message: error.message || 'Something went wrong' 
  });
});

// On Vercel the platform runs the exported app; locally we start a server.
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
  });
}

module.exports = app;

