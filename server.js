const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// Configuration Nodemailer
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_PORT == 465,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

async function sendNotificationEmail(visitorId, text) {
    if (!process.env.SMTP_USER || process.env.SMTP_USER.includes('@example.com') || process.env.SMTP_USER.includes('votre-email')) {
        console.log("[Notifications] SMTP non configuré, email ignoré.");
        return;
    }

    const mailOptions = {
        from: `"asad.to Alerte" <${process.env.SMTP_USER}>`,
        to: process.env.NOTIFICATION_EMAIL,
        subject: `Nouveau message de Visitor ${visitorId.substring(0, 5)}`,
        text: `Vous avez reçu un nouveau message sur asad.to :\n\n"${text}"\n\nRépondez sur votre dashboard: http://localhost:5175/inbox`,
        html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h2 style="color: #00b06b;">Nouveau message asad.to</h2>
                <p><strong>Visiteur:</strong> ${visitorId}</p>
                <p><strong>Message:</strong> "${text}"</p>
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                <a href="http://localhost:5175/inbox" style="background: #00b06b; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Répondre au client</a>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[Notifications] Email envoyé pour ${visitorId}`);
    } catch (error) {
        console.error("[Notifications] Erreur lors de l'envoi de l'email:", error.message);
    }
}

async function sendWhatsAppNotification(visitorId, text) {
    const number = process.env.WHATSAPP_NUMBER;
    if (!number || number === '33600000000') {
        console.log("[Notifications] WhatsApp non configuré (numéro manquant).");
        return;
    }

    const message = `Nouveau message asad.to de ${visitorId}: ${text}`;
    const encodedMsg = encodeURIComponent(message);
    const waLink = `https://wa.me/${number}?text=${encodedMsg}`;

    console.log(`[Notifications] ALERTE WHATSAPP pour ${number}: ${waLink}`);
}

app.get('/', (req, res) => {
    res.send('asad.to Backend API is running correctly.');
});

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Database connection & globals
let db;
const onlineVisitors = {};
const onlineAgents = {};

async function connectDB() {
    try {
        db = await mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
        console.log('Connecté à la base de données MySQL');

        // Robust migration
        try {
            const [columns] = await db.execute('SHOW COLUMNS FROM messages LIKE "is_read"');
            if (columns.length === 0) {
                await db.execute('ALTER TABLE messages ADD COLUMN is_read BOOLEAN DEFAULT FALSE');
                console.log('Colonne is_read ajoutée à la table messages');
            }

            const [convColumns] = await db.execute('SHOW COLUMNS FROM conversations LIKE "is_muted"');
            if (convColumns.length === 0) {
                await db.execute('ALTER TABLE conversations ADD COLUMN is_muted BOOLEAN DEFAULT FALSE');
                console.log('Colonne is_muted ajoutée à la table conversations');
            }

            const [userColumns] = await db.execute('SHOW COLUMNS FROM users LIKE "role"');
            if (userColumns.length === 0) {
                await db.execute('ALTER TABLE users ADD COLUMN role VARCHAR(20) DEFAULT "user"');
                console.log('Colonne role ajoutée à la table users');
            }

            const [statsTable] = await db.execute('SHOW TABLES LIKE "stats"');
            if (statsTable.length === 0) {
                await db.execute(`
                    CREATE TABLE stats (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        event_type VARCHAR(50) NOT NULL,
                        visitor_id VARCHAR(100),
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                console.log('Table stats créée');
            }

            // Ensure specific user is admin
            const adminEmail = 'nabilsaieddev@gmail.com';
            const [adminUser] = await db.execute('SELECT id, role FROM users WHERE email = ?', [adminEmail]);
            if (adminUser.length > 0 && adminUser[0].role !== 'admin') {
                await db.execute('UPDATE users SET role = "admin" WHERE id = ?', [adminUser[0].id]);
                console.log(`Utilisateur ${adminEmail} mis à jour en tant qu'administrateur.`);
            }

        } catch (migErr) {
            console.error('Erreur migration:', migErr.message);
        }
    } catch (err) {
        console.error('Erreur de connexion MySQL:', err);
    }
}
connectDB();

// API: Notifications (unread messages)
app.get('/api/notifications/unread', async (req, res) => {
    try {
        const [latest] = await db.execute(`
            SELECT m.*, c.visitor_id 
            FROM messages m
            JOIN conversations c ON m.conversation_id = c.id
            WHERE m.sender_type = 'visitor' AND m.is_read = FALSE AND c.is_muted = FALSE
            ORDER BY m.created_at DESC
            LIMIT 10
        `);

        const [[{ total }]] = await db.execute(`
            SELECT COUNT(*) as total 
            FROM messages m
            JOIN conversations c ON m.conversation_id = c.id
            WHERE m.sender_type = 'visitor' AND m.is_read = FALSE AND c.is_muted = FALSE
        `);

        res.json({ latest, total });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Mark as read
app.put('/api/conversations/:id/read', async (req, res) => {
    try {
        await db.execute('UPDATE messages SET is_read = TRUE WHERE conversation_id = ? AND sender_type = "visitor"', [req.params.id]);
        res.json({ message: 'Messages marqués comme lus' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Toggle Mute
app.put('/api/conversations/:id/mute', async (req, res) => {
    try {
        const [convs] = await db.execute('SELECT is_muted FROM conversations WHERE id = ?', [req.params.id]);
        if (convs.length === 0) return res.status(404).json({ error: 'Conversation non trouvée' });

        const newMute = !convs[0].is_muted;
        await db.execute('UPDATE conversations SET is_muted = ? WHERE id = ?', [newMute, req.params.id]);
        res.json({ is_muted: newMute });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Statistics
app.post('/api/stats', async (req, res) => {
    const { event_type, visitor_id } = req.body;
    try {
        console.log(`[Stats] Nouveau signal: ${event_type} de ${visitor_id}`);
        await db.execute('INSERT INTO stats (event_type, visitor_id) VALUES (?, ?)', [event_type, visitor_id]);
        res.status(201).json({ message: 'Stat enregistré' });
    } catch (err) {
        console.error('[Stats] Erreur sauvegarde:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats/summary', async (req, res) => {
    try {
        const [[{ count: clicks }]] = await db.execute('SELECT COUNT(*) as count FROM stats WHERE event_type = "site_click"');
        const onlineCount = Object.keys(onlineVisitors).length;

        // Count total agent messages
        const [[{ count: agentMessages }]] = await db.execute('SELECT COUNT(*) as count FROM messages WHERE sender_type = "agent"');

        console.log(`[Stats] Summary requested: ${clicks} clicks, ${onlineCount} online, ${agentMessages} agent msgs`);
        res.json({
            totalClicks: clicks,
            onlineVisitors: onlineCount,
            totalAgentMessages: agentMessages
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats/messages-by-day', async (req, res) => {
    try {
        // Obtenir les messages des 7 derniers jours par type d'expéditeur
        const [rows] = await db.execute(`
            SELECT 
                DATE_FORMAT(created_at, '%Y-%m-%d') as day,
                SUM(CASE WHEN sender_type = 'visitor' THEN 1 ELSE 0 END) as visitor_count,
                SUM(CASE WHEN sender_type = 'agent' THEN 1 ELSE 0 END) as agent_count
            FROM messages 
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
            GROUP BY day
            ORDER BY day ASC
        `);
        res.json(rows);
    } catch (err) {
        console.error('[Stats] Erreur messages-by-day:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/agents', async (req, res) => {
    try {
        const [agents] = await db.execute('SELECT id, name, email, role FROM users');
        res.json(agents);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bot logic
const botResponses = {
    "prix": "Le service de base asad.to est 100% gratuit à vie ! Nous proposons des options premium pour la personnalisation avancée.",
    "contact": "Vous pouvez nous contacter à support@asad.to ou appeler notre bureau à Bourg-la-Reine.",
    "aide": "Je peux vous aider à configurer votre widget, gérer vos agents ou personnaliser vos réponses automatiques.",
    "bonjour": "Bonjour ! Je suis l'assistant asad.to (Bourg-la-Reine). Comment puis-je vous aider ?",
    "hello": "Hi! I am the asad.to assistant. How can I help you today?"
};

async function handleBotAction(visitorId, text, conversationId) {
    const lowerText = text.toLowerCase();
    let responseText = "";

    for (const key in botResponses) {
        if (lowerText.includes(key)) {
            responseText = botResponses[key];
            break;
        }
    }

    if (responseText) {
        setTimeout(async () => {
            if (conversationId) {
                await db.execute(
                    'INSERT INTO messages (conversation_id, sender_type, content) VALUES (?, ?, ?)',
                    [conversationId, 'bot', responseText]
                );

                const visitorSocket = Object.keys(onlineVisitors).find(key => onlineVisitors[key].visitorId === visitorId);
                if (visitorSocket) {
                    onlineVisitors[visitorSocket].isBotActive = true;
                    onlineVisitors[visitorSocket].lastMessage = {
                        text: responseText,
                        sender: 'bot',
                        timestamp: Date.now()
                    };
                    io.to('agents_room').emit('visitor_list', Object.values(onlineVisitors));
                }
            }
            io.to(visitorId).emit('agent_message', { text: responseText, fromBot: true });
            io.to('agents_room').emit('visitor_message', { visitorId, text: responseText, fromBot: true });
        }, 1000);
    }
}

// Auth Endpoints
app.post('/api/signup', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) return res.status(400).json({ error: 'Email déjà utilisé' });

        const hash = await bcrypt.hash(password, 10);
        const [usersCount] = await db.execute('SELECT COUNT(*) as total FROM users');
        const role = usersCount[0].total === 0 ? 'admin' : 'user';

        await db.execute('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [name, email, hash, role]);
        res.status(201).json({ message: 'Utilisateur créé', role });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users', async (req, res) => {
    const { name, email, password, role } = req.body;
    try {
        const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) return res.status(400).json({ error: 'Email déjà utilisé' });

        const hash = await bcrypt.hash(password, 10);
        await db.execute('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [name, email, hash, role || 'user']);
        res.status(201).json({ message: 'Utilisateur créé' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) return res.status(401).json({ error: 'Identifiants invalides' });

        const user = users[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Identifiants invalides' });
        res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users/:id', async (req, res) => {
    try {
        const [users] = await db.execute('SELECT id, name, email, role FROM users WHERE id = ?', [req.params.id]);
        if (users.length === 0) return res.status(404).json({ error: 'Utilisateur non trouvé' });
        res.json(users[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/:id', async (req, res) => {
    const { name, email, role } = req.body;
    const { id } = req.params;
    try {
        if (role) {
            await db.execute('UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?', [name, email, role, id]);
        } else {
            await db.execute('UPDATE users SET name = ?, email = ? WHERE id = ?', [name, email, id]);
        }
        res.json({ message: 'Utilisateur mis à jour' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Cet email est déjà utilisé' });
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        await db.execute('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.json({ message: 'Utilisateur supprimé' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Conversations Endpoints
app.get('/api/conversations', async (req, res) => {
    try {
        const [convs] = await db.execute(`
            SELECT c.*, m.content as last_message, m.created_at as last_message_time,
            (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_type = 'visitor' AND is_read = FALSE) as unread_count
            FROM conversations c
            LEFT JOIN (
                SELECT conversation_id, content, created_at
                FROM messages
                WHERE id IN (SELECT MAX(id) FROM messages GROUP BY conversation_id)
            ) m ON c.id = m.conversation_id
            ORDER BY m.created_at DESC
        `);
        res.json(convs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/conversations/:id/messages', async (req, res) => {
    try {
        const [messages] = await db.execute(
            'SELECT sender_type as sender, content as text, created_at as timestamp FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
            [req.params.id]
        );
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Socket logic
io.on('connection', (socket) => {
    socket.on('register_visitor', async (data) => {
        onlineVisitors[socket.id] = {
            ...data,
            socketId: socket.id,
            joinedAt: Date.now(),
            lastMessage: { text: null, sender: null, timestamp: null }
        };
        socket.join(data.visitorId);

        let [convs] = await db.execute('SELECT id FROM conversations WHERE visitor_id = ? AND status = "open"', [data.visitorId]);
        let conversationId;

        if (convs.length === 0) {
            const [result] = await db.execute('INSERT INTO conversations (visitor_id) VALUES (?)', [data.visitorId]);
            conversationId = result.insertId;
        } else {
            conversationId = convs[0].id;
        }

        socket.conversationId = conversationId;
        const [history] = await db.execute('SELECT sender_type as sender, content as text, created_at as timestamp FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [conversationId]);
        socket.emit('chat_history', history);
        io.to('agents_room').emit('visitor_list', Object.values(onlineVisitors));
    });

    socket.on('register_agent', (data) => {
        onlineAgents[socket.id] = { ...data, socketId: socket.id, joinedAt: Date.now() };
        socket.join('agents_room');
        socket.emit('visitor_list', Object.values(onlineVisitors));
        io.to('agents_room').emit('agent_list', Object.values(onlineAgents));
    });

    socket.on('visitor_message', async (data) => {
        const visitor = onlineVisitors[socket.id];
        if (visitor) {
            try {
                const [convs] = await db.execute('SELECT is_muted FROM conversations WHERE id = ?', [socket.conversationId]);
                const isMuted = convs.length > 0 ? convs[0].is_muted : false;

                await db.execute('INSERT INTO messages (conversation_id, sender_type, content) VALUES (?, ?, ?)', [socket.conversationId, 'visitor', data.text]);

                visitor.lastMessage = { text: data.text, sender: 'visitor', timestamp: Date.now() };
                io.to('agents_room').emit('visitor_list', Object.values(onlineVisitors));
                io.to('agents_room').emit('visitor_message', { visitorId: visitor.visitorId, text: data.text, timestamp: Date.now(), isMuted });

                if (!isMuted) {
                    sendNotificationEmail(visitor.visitorId, data.text);
                    sendWhatsAppNotification(visitor.visitorId, data.text);
                }

                handleBotAction(visitor.visitorId, data.text, socket.conversationId);
            } catch (err) {
                console.error('[Socket] Erreur sauvegarde message:', err.message);
            }
        }
    });

    socket.on('agent_message', async (data) => {
        let [convs] = await db.execute('SELECT id FROM conversations WHERE visitor_id = ? AND status = "open"', [data.visitorId]);
        if (convs.length > 0) {
            await db.execute('INSERT INTO messages (conversation_id, sender_type, content) VALUES (?, ?, ?)', [convs[0].id, 'agent', data.text]);

            const visitorSocket = Object.keys(onlineVisitors).find(key => onlineVisitors[key].visitorId === data.visitorId);
            if (visitorSocket) {
                onlineVisitors[visitorSocket].isBotActive = false;
                onlineVisitors[visitorSocket].lastMessage = { text: data.text, sender: 'agent', timestamp: Date.now() };
                io.to('agents_room').emit('visitor_list', Object.values(onlineVisitors));
            }
        }
        io.to(data.visitorId).emit('agent_message', { text: data.text, timestamp: Date.now() });
    });

    socket.on('typing', (data) => {
        if (data.isAgent) {
            io.to(data.visitorId).emit('typing', { isAgent: true });
        } else {
            io.to('agents_room').emit('typing', { visitorId: data.visitorId });
        }
    });

    socket.on('disconnect', () => {
        delete onlineVisitors[socket.id];
        delete onlineAgents[socket.id];
        io.to('agents_room').emit('visitor_list', Object.values(onlineVisitors));
        io.to('agents_room').emit('agent_list', Object.values(onlineAgents));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur en cours d'exécution sur le port ${PORT}`);
});
