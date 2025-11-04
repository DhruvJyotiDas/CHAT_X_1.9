// server.js (Secure Version with Environment Variables)
require('dotenv').config(); // Load environment variables

const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const mongoose = require("mongoose");
const Sentiment = require('sentiment');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false,
  clientTracking: true
});

const sentiment = new Sentiment();

// 🔒 Secure: Load MongoDB URI from environment variables
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI environment variable is not set!");
  process.exit(1);
}

// MongoDB Connection
mongoose.connect(MONGODB_URI, { 
  family: 4,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err.message);
    process.exit(1);
  });

// Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS ? 
  process.env.ALLOWED_ORIGINS.split(',') : 
  ['http://localhost:8000'];

app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? allowedOrigins : '*',
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'client')));

const User = require('./models/User');

// 🛡️ Input Validation Helper
function validateInput(data, requiredFields) {
  for (const field of requiredFields) {
    if (!data[field] || typeof data[field] !== 'string' || data[field].trim() === '') {
      return false;
    }
  }
  return true;
}

// 🔐 Registration Endpoint
app.post('/register', async (req, res) => {
  const { username, password, dob, gender } = req.body;
  
  if (!validateInput(req.body, ['username', 'password'])) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  // 🛡️ Validate username format
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: "Invalid username format (3-20 alphanumeric characters)" });
  }

  try {
    const exists = await User.findOne({ username });
    if (exists) {
      return res.status(400).json({ error: "User already exists" });
    }

    // ⚠️ TODO: Hash passwords using bcrypt
    const newUser = new User({ 
      username: username.trim(), 
      password,
      dob, 
      gender, 
      contacts: [], 
      messages: [] 
    });
    
    await newUser.save();
    res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Server error during registration" });
  }
});

// 🔐 Login Endpoint
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!validateInput(req.body, ['username', 'password'])) {
    return res.status(400).json({ error: "Username and password required" });
  }

  try {
    const user = await User.findOne({ username: username.trim(), password });
    
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    res.status(200).json({ 
      message: "Login successful", 
      username: user.username, 
      token: "dummy-token"
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// WebSocket Management
let clients = {};
let groups = {};

const ALLOWED_WS_ORIGINS = process.env.ALLOWED_WS_ORIGINS ? 
  process.env.ALLOWED_WS_ORIGINS.split(',') : 
  ['http://localhost:8000', 'http://127.0.0.1:8000'];

wss.on("connection", (ws, req) => {
  console.log('🔌 New WebSocket connection');
  
  // 🛡️ Origin validation (only in production)
  const origin = req.headers.origin;
  if (process.env.NODE_ENV === 'production' && origin && !ALLOWED_WS_ORIGINS.includes(origin)) {
    console.warn(`⚠️ Rejected connection from: ${origin}`);
    ws.close(1008, 'Origin not allowed');
    return;
  }

  let username = null;
  let isAlive = true;

  ws.on('pong', () => {
    isAlive = true;
  });

  ws.on("error", (error) => {
    console.error(`❌ WebSocket error for ${username || 'unknown'}:`, error.message);
  });

  ws.on("message", async (data) => {
    let message;
    
    try {
      message = JSON.parse(data);
    } catch (error) {
      console.error("⚠️ Invalid JSON:", error.message);
      ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
      return;
    }

    if (!message.type) {
      ws.send(JSON.stringify({ type: "error", message: "Message type required" }));
      return;
    }

    // Handle connection
    if (message.type === "connect") {
      if (!message.username || typeof message.username !== 'string') {
        ws.send(JSON.stringify({ type: "error", message: "Valid username required" }));
        ws.close();
        return;
      }

      username = message.username.trim();

      if (clients[username]) {
        ws.send(JSON.stringify({ type: "error", message: "Username already taken" }));
        ws.close();
        return;
      }

      clients[username] = ws;
      console.log(`✅ ${username} connected`);
      ws.send(JSON.stringify({ type: "connect-response", success: true, username }));
      broadcastUserList();
    }

    // Handle messages
    else if (message.type === "message") {
      if (!username) {
        ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
        return;
      }

      if (!message.message || typeof message.message !== 'string' || message.message.trim() === '') {
        ws.send(JSON.stringify({ type: "error", message: "Message content required" }));
        return;
      }

      const MAX_MESSAGE_LENGTH = 5000;
      if (message.message.length > MAX_MESSAGE_LENGTH) {
        ws.send(JSON.stringify({ type: "error", message: "Message too long" }));
        return;
      }

      const isGroup = message.recipient && message.recipient.startsWith("group-");
      const timestamp = new Date();
      
      // Sentiment Analysis
      const result = sentiment.analyze(message.message);
      let mood = "neutral";
      if (result.score > 2) mood = "happy";
      else if (result.score < -2) mood = "sad";
      else if (result.score < 0) mood = "angry";
      
      const payload = {
        type: "message",
        sender: message.sender,
        recipient: message.recipient,
        message: message.message,
        timestamp: timestamp.toLocaleString(),
        mood: mood
      };

      try {
        const chatMessage = {
          sender: message.sender,
          message: message.message,
          timestamp
        };

        // Update sender
        await User.updateOne(
          { username: message.sender, "messages.with": message.recipient },
          { 
            $addToSet: { contacts: message.recipient },
            $push: { "messages.$.chat": chatMessage }
          }
        );

        await User.updateOne(
          { username: message.sender, "messages.with": { $ne: message.recipient } },
          {
            $addToSet: { contacts: message.recipient },
            $push: {
              messages: {
                with: message.recipient,
                chat: [chatMessage]
              }
            }
          }
        );

        // Update recipient (only for direct messages)
        if (!isGroup) {
          await User.updateOne(
            { username: message.recipient, "messages.with": message.sender },
            {
              $addToSet: { contacts: message.sender },
              $push: { "messages.$.chat": chatMessage }
            }
          );

          await User.updateOne(
            { username: message.recipient, "messages.with": { $ne: message.sender } },
            {
              $addToSet: { contacts: message.sender },
              $push: {
                messages: {
                  with: message.sender,
                  chat: [chatMessage]
                }
              }
            }
          );
        }
      } catch (err) {
        console.error("❌ MongoDB save error:", err);
      }

      // Deliver message
      if (isGroup && groups[message.recipient]) {
        groups[message.recipient].forEach(member => {
          if (member !== message.sender && clients[member] && clients[member].readyState === WebSocket.OPEN) {
            clients[member].send(JSON.stringify(payload));
          }
        });
      } else if (clients[message.recipient] && clients[message.recipient].readyState === WebSocket.OPEN) {
        clients[message.recipient].send(JSON.stringify(payload));
      }
    }

    // Handle typing indicator
    else if (message.type === "typing") {
      if (!username) return;
      
      const peer = clients[message.recipient];
      if (peer && peer.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({ type: "typing", sender: message.sender }));
      }
    }
  });

  ws.on("close", () => {
    if (username && clients[username]) {
      console.log(`🔌 ${username} disconnected`);
      delete clients[username];
      broadcastUserList();
    }
  });
});

// Heartbeat to clean dead connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Broadcast user list
function broadcastUserList() {
  const users = Object.keys(clients).filter(user => 
    clients[user].readyState === WebSocket.OPEN
  );
  
  const msg = JSON.stringify({ type: "updateUsers", users });
  
  for (let user in clients) {
    if (clients[user].readyState === WebSocket.OPEN) {
      clients[user].send(msg);
    }
  }
}

// Chat History Endpoint
app.get('/history', async (req, res) => {
  const { user, peer } = req.query;
  
  if (!user || !peer) {
    return res.status(400).json({ error: "Missing user or peer parameter" });
  }

  try {
    const currentUser = await User.findOne({ username: user });
    
    if (!currentUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const history = currentUser.messages.find(entry => entry.with === peer);
    
    if (!history || !history.chat) {
      return res.json([]);
    }

    const LIMIT = parseInt(req.query.limit) || 100;
    const messages = history.chat.slice(-LIMIT);
    
    res.json(messages);
  } catch (err) {
    console.error("❌ History fetch error:", err);
    res.status(500).json({ error: "Failed to fetch chat history" });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activeConnections: wss.clients.size,
    mongoStatus: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Start server
const PORT = process.env.PORT || 8000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received: closing server');
  server.close(() => {
    mongoose.connection.close(false, () => {
      console.log('✅ Server closed gracefully');
      process.exit(0);
    });
  });
});
