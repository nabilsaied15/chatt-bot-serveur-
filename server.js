const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// Configuration Nodemailer
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: parseInt(process.env.SMTP_PORT || "587") === 465,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    },
    connectionTimeout: 5000, // 5 secondes max
    greetingTimeout: 5000,
    socketTimeout: 10000
});

transporter.verify((error, success) => {
    if (error) {
        console.error("[Notifications] SMTP Error:", error.message);
    } else {
        console.log("[Notifications] SMTP Ready.");
    }
});
console.log(`[Notifications] Nodemailer: ${process.env.SMTP_HOST || 'smtp.gmail.com'}:${process.env.SMTP_PORT || 587}`);

async function sendNotificationEmail(visitorId, text, targetEmail = null, customApiKey = null, senderEmail = null) {
    const BREVO_API_KEY = customApiKey || process.env.BREVO_API_KEY;
    const NOTIF_EMAIL = targetEmail || process.env.NOTIFICATION_EMAIL;
    const SENDER_EMAIL = senderEmail || NOTIF_EMAIL || "nabilsaied04@gmail.com";

    if (!BREVO_API_KEY) {
        console.log("[Notifications] BREVO_API_KEY non configurée. Tentative SMTP...");
        // Fallback SMTP (probablement bloqué sur Render mais utile en local)
        if (!process.env.SMTP_USER) return;
        try {
            await transporter.sendMail({
                from: `"asad.to" <${process.env.SMTP_USER}>`,
                to: NOTIF_EMAIL || process.env.SMTP_USER,
                subject: "Nouveau message sur le site",
                text: `Message de ${visitorId}: ${text}`
            });
        } catch (e) { console.error("[Notifications] Erreur SMTP:", e.message); }
        return;
    }

    // Envoi via API Brevo (HTTP) - Passe à travers les blocages Render
    const https = require('https');
    const data = JSON.stringify({
        sender: { name: "asad.to", email: SENDER_EMAIL },
        to: [{ email: NOTIF_EMAIL || "nabilsaied04@gmail.com" }],
        subject: "Vous avez un nouveau message sur le site",
        htmlContent: `
            <div style="font-family:sans-serif; padding:20px;">
                <h2 style="color:#00b06b;">Nouveau message asad.to</h2>
                <p><strong>Visiteur:</strong> ${visitorId.substring(0, 8)}</p>
                <p><strong>Message:</strong> "${text}"</p>
                <a href="https://asad-chat-bot.vercel.app/inbox" style="display:inline-block; background:#00b06b; color:white; padding:10px 20px; text-decoration:none; border-radius:5px;">Répondre au client</a>
            </div>`
    });

    const options = {
        hostname: 'api.brevo.com',
        path: '/v3/smtp/email',
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'api-key': BREVO_API_KEY,
            'content-type': 'application/json',
            'content-length': data.length
        }
    };

    const req = https.request(options, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => console.log(`[Notifications] Brevo API Response: ${res.statusCode} ${body}`));
    });

    req.on('error', (e) => console.error(`[Notifications] Brevo API Error: ${e.message}`));
    req.write(data);
    req.end();
}

async function sendWhatsAppNotification(visitorId, text, targetPhone = null, customApiKey = null) {
    const number = (targetPhone || process.env.WHATSAPP_NUMBER || "").replace(/\s+/g, "").replace("+", "");
    const apikey = customApiKey || process.env.WHATSAPP_API_KEY || process.env.CALLMEBOT_API_KEY;

    if (!number || number === '33600000000' || number === "") {
        console.log("[Notifications] WhatsApp non configuré (numéro manquant).");
        return;
    }

    if (!apikey) {
        console.log("[Notifications] WhatsApp API Key manquante (CallMeBot).");
        const encodedMsg = encodeURIComponent(`Nouveau message de ${visitorId}: ${text}`);
        console.log(`[Notifications] ALERTE WHATSAPP (Lien :): https://wa.me/${number}?text=${encodedMsg}`);
        return;
    }

    const message = `*Notification asad.to*\nVisiteur: ${visitorId.substring(0, 8)}\nMessage: ${text}\nLien: https://asad-chat-bot.vercel.app/inbox`;
    const url = `https://api.callmebot.com/whatsapp.php?phone=${number}&text=${encodeURIComponent(message)}&apikey=${apikey}`;

    const https = require('https');
    https.get(url, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
            console.log(`[Notifications] WhatsApp CallMeBot Status: ${res.statusCode}`);
            if (res.statusCode !== 200) console.error(`[Notifications] WhatsApp Error Body: ${body}`);
        });
    }).on('error', (e) => console.error(`[Notifications] WhatsApp Network Error: ${e.message}`));
}


app.get('/', (req, res) => {
    res.send('asad.to Backend API is running correctly. Version 1.0.2');
});

app.get('/api/version', (req, res) => {
    res.json({ version: '1.0.2', status: 'ready', database: db ? 'connected' : 'disconnected' });
});

app.get('/api/debug/db-check', async (req, res) => {
    try {
        const [tables] = await db.execute('SHOW TABLES');
        let settingsSchema = null;
        try {
            const [schema] = await db.execute('DESCRIBE settings');
            settingsSchema = schema;
        } catch (e) {
            settingsSchema = `Error: ${e.message}`;
        }

        res.json({
            status: 'ok',
            tables: tables.map(t => Object.values(t)[0]),
            settings_schema: settingsSchema,
            env: {
                DB_HOST: process.env.DB_HOST ? 'Configured' : 'Missing',
                DB_NAME: process.env.DB_NAME
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message, code: err.code });
    }
});

app.get('/api/debug/force-repair-db', async (req, res) => {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS settings (
                user_id INT PRIMARY KEY,
                primary_color VARCHAR(20) DEFAULT '#00b06b',
                welcome_message TEXT,
                email_notifications BOOLEAN DEFAULT TRUE,
                whatsapp_notifications BOOLEAN DEFAULT FALSE,
                whatsapp_number VARCHAR(100),
                brevo_api_key VARCHAR(255),
                callmebot_api_key VARCHAR(255)
            )
        `);

        // S'assurer que les colonnes existent si la table existait déjà
        try {
            const [columns] = await db.execute('SHOW COLUMNS FROM settings');
            const columnNames = columns.map(c => c.Field);
            if (!columnNames.includes('brevo_api_key')) {
                await db.execute('ALTER TABLE settings ADD COLUMN brevo_api_key VARCHAR(255)');
            }
            if (!columnNames.includes('callmebot_api_key')) {
                await db.execute('ALTER TABLE settings ADD COLUMN callmebot_api_key VARCHAR(255)');
            }
        } catch (colErr) {
            console.error('Erreur forcée colonnes:', colErr.message);
        }

        res.json({ status: 'ok', message: 'Table settings réparée et mise à jour avec les colonnes API' });
    } catch (err) {
        res.status(500).json({ error: err.message, code: err.code });
    }
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
        const dbConfig = {
            host: process.env.DB_HOST?.trim(),
            user: process.env.DB_USER?.trim(),
            password: process.env.DB_PASS?.trim(),
            database: process.env.DB_NAME?.trim(),
            port: parseInt(process.env.DB_PORT?.trim() || "3306"),
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        };

        // Aiven nécessite SSL
        if (process.env.DB_SSL?.trim() === 'true') {
            dbConfig.ssl = { rejectUnauthorized: false };
        }

        db = await mysql.createPool(dbConfig);

        // Test de connexion immédiat
        try {
            await db.execute('SELECT 1');
            console.log('Connecté à la base de données MySQL et vérifié.');
        } catch (connErr) {
            console.error('ALERTE: Pool créé mais connexion impossible:', connErr.message);
            if (connErr.code === 'ENOTFOUND') {
                console.error('CONSEIL: Le nom d\'hôte (DB_HOST) est introuvable. Vérifiez vos variables d\'environnement Render.');
            }
        }

        // Robust migration
        try {
            // Création des tables de base si elles n'existent pas
            await db.execute(`
                CREATE TABLE IF NOT EXISTS users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(100),
                    email VARCHAR(100) UNIQUE,
                    password_hash VARCHAR(255),
                    role VARCHAR(20) DEFAULT 'user',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            await db.execute(`
                CREATE TABLE IF NOT EXISTS conversations (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    visitor_id VARCHAR(100),
                    status VARCHAR(20) DEFAULT 'open',
                    is_muted BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Migration: S'assurer que les colonnes existent pour les anciennes installations
            try {
                const [columns] = await db.execute('SHOW COLUMNS FROM conversations');
                const columnNames = columns.map(c => c.Field);

                if (!columnNames.includes('status')) {
                    await db.execute("ALTER TABLE conversations ADD COLUMN status VARCHAR(20) DEFAULT 'open'");
                    console.log('Migration: Colonne status ajoutée à conversations');
                }
                if (!columnNames.includes('is_muted')) {
                    await db.execute('ALTER TABLE conversations ADD COLUMN is_muted BOOLEAN DEFAULT FALSE');
                    console.log('Migration: Colonne is_muted ajoutée à conversations');
                }
                if (!columnNames.includes('first_name')) {
                    await db.execute('ALTER TABLE conversations ADD COLUMN first_name VARCHAR(100)');
                    console.log('Migration: Colonne first_name ajoutée à conversations');
                }
                if (!columnNames.includes('last_name')) {
                    await db.execute('ALTER TABLE conversations ADD COLUMN last_name VARCHAR(100)');
                    console.log('Migration: Colonne last_name ajoutée à conversations');
                }
                if (!columnNames.includes('whatsapp')) {
                    await db.execute('ALTER TABLE conversations ADD COLUMN whatsapp VARCHAR(100)');
                    console.log('Migration: Colonne whatsapp ajoutée à conversations');
                }
                if (!columnNames.includes('problem')) {
                    await db.execute('ALTER TABLE conversations ADD COLUMN problem TEXT');
                    console.log('Migration: Colonne problem ajoutée à conversations');
                }
                if (!columnNames.includes('agent_id')) {
                    await db.execute('ALTER TABLE conversations ADD COLUMN agent_id INT');
                    console.log('Migration: Colonne agent_id ajoutée à conversations');
                }
            } catch (colErr) {
                console.error('Erreur vérification colonnes:', colErr.message);
            }

            await db.execute(`
                CREATE TABLE IF NOT EXISTS messages (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    conversation_id INT,
                    sender_type VARCHAR(20),
                    content TEXT,
                    is_read BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

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

            // Migration Settings - Robust version that adds missing columns
            await db.execute(`
                CREATE TABLE IF NOT EXISTS settings (
                    user_id INT PRIMARY KEY,
                    primary_color VARCHAR(20) DEFAULT '#00b06b',
                    welcome_message TEXT,
                    email_notifications BOOLEAN DEFAULT TRUE,
                    whatsapp_notifications BOOLEAN DEFAULT FALSE,
                    whatsapp_number VARCHAR(100),
                    brevo_api_key VARCHAR(255),
                    callmebot_api_key VARCHAR(255)
                )
            `);

            // Check and add missing columns if table already exists
            const [settingsColumns] = await db.execute('SHOW COLUMNS FROM settings');
            const settingsColumnNames = settingsColumns.map(c => c.Field);

            if (!settingsColumnNames.includes('brevo_api_key')) {
                console.log('[Migration] Ajout de la colonne brevo_api_key');
                await db.execute('ALTER TABLE settings ADD COLUMN brevo_api_key VARCHAR(255)');
            }
            if (!settingsColumnNames.includes('callmebot_api_key')) {
                console.log('[Migration] Ajout de la colonne callmebot_api_key');
                await db.execute('ALTER TABLE settings ADD COLUMN callmebot_api_key VARCHAR(255)');
            }


            try {
                const [columns] = await db.execute('SHOW COLUMNS FROM settings');
                const columnNames = columns.map(c => c.Field);
                if (!columnNames.includes('brevo_api_key')) {
                    await db.execute('ALTER TABLE settings ADD COLUMN brevo_api_key VARCHAR(255)');
                }
                if (!columnNames.includes('callmebot_api_key')) {
                    await db.execute('ALTER TABLE settings ADD COLUMN callmebot_api_key VARCHAR(255)');
                }
                await db.execute('ALTER TABLE settings MODIFY COLUMN whatsapp_number VARCHAR(100)');
            } catch (err) {
                console.log('Migration Settings Note:', err.message);
            }

            console.log('Table settings vérifiée/créée');

            // Migration Stats (Ensure it exists for the summary page)
            await db.execute(`
                CREATE TABLE IF NOT EXISTS stats (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    event_type VARCHAR(50) NOT NULL,
                    visitor_id VARCHAR(100),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('Table stats vérifiée/créée');
        } catch (migErr) {
            console.error('CRITICAL Migration Error:', migErr.message);
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
        await db.execute("UPDATE messages SET is_read = TRUE WHERE conversation_id = ? AND sender_type = 'visitor'", [req.params.id]);
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

// Endpoint pour tester l'email manuellement avec diagnostics
app.get('/api/stats/test-email', async (req, res) => {
    const BREVO_API_KEY = process.env.BREVO_API_KEY;
    const testTarget = req.query.email || process.env.NOTIFICATION_EMAIL || "nabilsaied04@gmail.com";

    // Si Brevo est configuré, on teste l'API
    if (BREVO_API_KEY) {
        try {
            const https = require('https');
            const data = JSON.stringify({
                sender: { name: "asad.to Test", email: testTarget },
                to: [{ email: testTarget }],
                subject: "Test Diagnostic Brevo asad.to",
                htmlContent: `<h2>Succès !</h2><p>L'API Brevo est bien configurée sur votre serveur Render.</p>`
            });

            const options = {
                hostname: 'api.brevo.com',
                path: '/v3/smtp/email',
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'api-key': BREVO_API_KEY,
                    'content-type': 'application/json',
                    'content-length': data.length
                }
            };

            const brevoReq = https.request(options, (brevoRes) => {
                let body = '';
                brevoRes.on('data', d => body += d);
                brevoRes.on('end', () => {
                    if (brevoRes.statusCode >= 200 && brevoRes.statusCode < 300) {
                        res.json({ success: true, message: `Email de test envoyé via Brevo à ${testTarget}` });
                    } else {
                        res.status(brevoRes.statusCode).json({ success: false, phase: "Brevo API", error: body });
                    }
                });
            });

            brevoReq.on('error', (e) => res.status(500).json({ success: false, phase: "Réseau", error: e.message }));
            brevoReq.write(data);
            brevoReq.end();
            return;
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    // Sinon, on teste le SMTP classique (Diagnostic de base)
    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = parseInt(process.env.SMTP_PORT || "587");

    const net = require('net');
    const checkConnection = () => {
        return new Promise((resolve) => {
            const socket = net.createConnection(port, host);
            socket.setTimeout(3000);
            socket.on('connect', () => { socket.destroy(); resolve({ ok: true }); });
            socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: "Timeout réseau (3s) - Le port est bloqué sur Render." }); });
            socket.on('error', (err) => { socket.destroy(); resolve({ ok: false, error: err.message }); });
        });
    };

    const netResult = await checkConnection();
    if (!netResult.ok) {
        return res.status(500).json({
            success: false,
            phase: "Réseau (SMTP bloqué ?)",
            error: netResult.error,
            hint: "Render bloque souvent les ports SMTP. Utilisez BREVO_API_KEY pour contourner cela."
        });
    }

    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return res.status(400).json({ success: false, error: "Configuration SMTP incomplète et BREVO_API_KEY manquante." });
    }

    try {
        await transporter.sendMail({
            from: `"asad.to Test" <${process.env.SMTP_USER}>`,
            to: testTarget,
            subject: "Test SMTP asad.to",
            text: "Succès ! Votre configuration SMTP fonctionne."
        });
        res.json({ success: true, message: `Email envoyé via SMTP à ${testTarget}` });
    } catch (err) {
        res.status(500).json({ success: false, phase: "Authentification SMTP", error: err.message });
    }
});

app.get('/api/stats/summary', async (req, res) => {
    try {
        const [[{ count: clicks }]] = await db.execute('SELECT COUNT(*) as count FROM stats WHERE event_type = "site_click"');
        const onlineCount = Object.keys(onlineVisitors).length;

        // Count total messages
        const [[{ count: agentMessages }]] = await db.execute('SELECT COUNT(*) as count FROM messages WHERE sender_type = "agent"');
        const [[{ count: visitorMessages }]] = await db.execute('SELECT COUNT(*) as count FROM messages WHERE sender_type = "visitor"');

        // Advanced Stats: Total Conversations
        const [[{ count: totalConvs }]] = await db.execute('SELECT COUNT(*) as count FROM conversations WHERE status != "deleted"');

        // Advanced Stats: Avg Response Time (Seconds)
        const [respTimeResult] = await db.execute(`
            SELECT AVG(TIMESTAMPDIFF(SECOND, first_visitor.created_at, first_agent.created_at)) as avg_seconds
            FROM (
                SELECT conversation_id, MIN(created_at) as created_at
                FROM messages
                WHERE sender_type = 'visitor'
                GROUP BY conversation_id
            ) first_visitor
            JOIN (
                SELECT conversation_id, MIN(created_at) as created_at
                FROM messages
                WHERE sender_type = 'agent'
                GROUP BY conversation_id
            ) first_agent ON first_visitor.conversation_id = first_agent.conversation_id
            WHERE first_agent.created_at > first_visitor.created_at
        `);
        const avgResponseTime = respTimeResult[0].avg_seconds || 0;

        res.json({
            totalClicks: clicks,
            onlineVisitors: onlineCount,
            totalAgentMessages: agentMessages,
            totalVisitorMessages: visitorMessages,
            totalConversations: totalConvs,
            avgResponseTime: Math.round(avgResponseTime)
        });
    } catch (err) {
        console.error('[Stats] Summary error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats/messages-by-day', async (req, res) => {
    const { period } = req.query;
    let days = 29;
    let format = '%Y-%m-%d';
    let interval = 'DAY';
    let groupFormat = '%Y-%m-%d';

    if (period === '7d') days = 6;
    else if (period === '1y') {
        days = 11;
        interval = 'MONTH';
        groupFormat = '%Y-%m';
    } else if (period === 'all') {
        days = 36;
        interval = 'MONTH';
        groupFormat = '%Y-%m';
    }

    try {
        const query = interval === 'DAY' ? `
            SELECT 
                DATE_FORMAT(created_at, '${groupFormat}') as day,
                SUM(CASE WHEN sender_type = 'visitor' THEN 1 ELSE 0 END) as visitor_count,
                SUM(CASE WHEN sender_type = 'agent' THEN 1 ELSE 0 END) as agent_count
            FROM messages 
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${days} DAY)
            GROUP BY day
            ORDER BY day ASC
        ` : `
            SELECT 
                DATE_FORMAT(created_at, '${groupFormat}') as day,
                SUM(CASE WHEN sender_type = 'visitor' THEN 1 ELSE 0 END) as visitor_count,
                SUM(CASE WHEN sender_type = 'agent' THEN 1 ELSE 0 END) as agent_count
            FROM messages 
            WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ${days} MONTH)
            GROUP BY day
            ORDER BY day ASC
        `;

        const [rows] = await db.execute(query);
        res.json(rows);
    } catch (err) {
        console.error('[Stats] Erreur messages-by-day:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats/hourly-activity', async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT HOUR(created_at) as hour, COUNT(*) as count
            FROM messages
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY hour
            ORDER BY hour ASC
        `);
        res.json(rows);
    } catch (err) {
        console.error('[Stats] Hourly error:', err.message);
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

    if (!db) {
        return res.status(503).json({ error: 'La base de données n\'est pas encore connectée. Veuillez réessayer dans quelques instants ou vérifier votre configuration DB_HOST.' });
    }

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

app.put('/api/users/:id/password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const { id } = req.params;
    try {
        const [users] = await db.execute('SELECT password_hash FROM users WHERE id = ?', [id]);
        if (users.length === 0) return res.status(404).json({ error: 'Utilisateur non trouvé' });

        const match = await bcrypt.compare(currentPassword, users[0].password_hash);
        if (!match) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });

        const hash = await bcrypt.hash(newPassword, 10);
        await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, id]);
        res.json({ success: true, message: 'Mot de passe mis à jour' });
    } catch (err) {
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

// Settings Endpoints
app.get('/api/settings/:userId', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM settings WHERE user_id = ?', [req.params.userId]);
        if (rows.length === 0) {
            return res.json({
                primary_color: '#00b06b',
                welcome_message: 'Bonjour ! Comment pouvons-nous vous aider ?',
                email_notifications: 1,
                whatsapp_notifications: 0,
                whatsapp_number: ''
            });
        }
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/public/settings/:siteKey', async (req, res) => {
    const { siteKey } = req.params;
    try {
        // Extract userId from 'asad_key_ID_live'
        const match = siteKey.match(/asad_key_(\d+)_live/);
        if (!match) return res.status(400).json({ error: 'Site Key invalide' });

        const userId = match[1];
        const [rows] = await db.execute('SELECT primary_color, welcome_message FROM settings WHERE user_id = ?', [userId]);

        if (rows.length === 0) {
            return res.json({
                primary_color: '#00b06b',
                welcome_message: 'Bonjour ! Comment pouvons-nous vous aider ?'
            });
        }
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/:userId', async (req, res) => {
    const { primary_color, welcome_message, email_notifications, whatsapp_notifications, whatsapp_number, brevo_api_key, callmebot_api_key } = req.body;
    const userId = parseInt(req.params.userId);
    console.log(`[Settings] Save request for user ${userId}:`, req.body);

    if (isNaN(userId)) {
        return res.status(400).json({ error: 'ID utilisateur invalide' });
    }

    try {
        console.log(`[SQL] Sauvegarde des paramètres pour UserID: ${userId}`);
        await db.execute(`
                INSERT INTO settings (
                    user_id, primary_color, welcome_message,
                    email_notifications, whatsapp_notifications, whatsapp_number,
                    brevo_api_key, callmebot_api_key
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    primary_color = VALUES(primary_color),
                    welcome_message = VALUES(welcome_message),
                    email_notifications = VALUES(email_notifications),
                    whatsapp_notifications = VALUES(whatsapp_notifications),
                    whatsapp_number = VALUES(whatsapp_number),
                    brevo_api_key = VALUES(brevo_api_key),
                    callmebot_api_key = VALUES(callmebot_api_key)
            `, [
            userId, primary_color, welcome_message,
            email_notifications ? 1 : 0, whatsapp_notifications ? 1 : 0, whatsapp_number,
            brevo_api_key || null, callmebot_api_key || null
        ]);
        res.json({ success: true, message: 'Paramètres enregistrés' });
    } catch (err) {
        console.error(`[Settings] Erreur lors de la sauvegarde pour l'utilisateur ${userId}:`, err.message);
        res.status(500).json({
            error: 'Erreur base de données',
            details: err.message,
            code: err.code,
            sql: err.sql // Only for debugging, remove later if needed
        });
    }
});

// Conversations Endpoints
app.post('/api/settings/:userId/test-notifications', async (req, res) => {
    const { type } = req.body;
    const userId = parseInt(req.params.userId);

    try {
        const [rows] = await db.execute('SELECT * FROM settings WHERE user_id = ?', [userId]);
        const settings = rows[0] || {};

        if (type === 'email') {
            const [user] = await db.execute('SELECT email FROM users WHERE id = ?', [userId]);
            const email = user[0]?.email || process.env.NOTIFICATION_EMAIL;
            await sendNotificationEmail("TEST_SYSTEM", "Ceci est un test de notification par email asad.to", email, settings.brevo_api_key, email);
            res.json({ success: true, message: `Email de test envoyé à ${email}${settings.brevo_api_key ? ' (via votre clé personnalisée)' : ''}` });
        } else if (type === 'whatsapp') {
            const number = settings.whatsapp_number || process.env.WHATSAPP_NUMBER;
            await sendWhatsAppNotification("TEST_SYSTEM", "Ceci est un test de notification WhatsApp asad.to", number, settings.callmebot_api_key);
            res.json({ success: true, message: `Séquence WhatsApp lancée pour ${number}${settings.callmebot_api_key ? ' (via votre clé personnalisée)' : ''}. Vérifiez votre téléphone.` });

        } else {
            res.status(400).json({ error: 'Type de test invalide' });
        }
    } catch (err) {
        console.error('[Settings] Test Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/conversations', async (req, res) => {
    const { status } = req.query;
    try {
        let query = `
            SELECT c.*, m.content as last_message, m.created_at as last_message_time,
            (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_type = 'visitor' AND is_read = FALSE) as unread_count
            FROM conversations c
            LEFT JOIN (
                SELECT conversation_id, content, created_at
                FROM messages
                WHERE id IN (SELECT MAX(id) FROM messages GROUP BY conversation_id)
            ) m ON c.id = m.conversation_id
        `;

        const params = [];
        if (status) {
            query += ' WHERE c.status = ?';
            params.push(status);
        } else {
            query += " WHERE c.status != 'deleted'";
        }

        query += ' ORDER BY m.created_at DESC';

        const [convs] = await db.execute(query, params);
        res.json(convs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/conversations/:id/status', async (req, res) => {
    const { status } = req.body;
    if (!['open', 'closed', 'deleted'].includes(status)) {
        return res.status(400).json({ error: 'Status invalide' });
    }
    try {
        await db.execute('UPDATE conversations SET status = ? WHERE id = ?', [status, req.params.id]);
        res.json({ message: `Status mis à jour vers ${status}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/conversations/:id', async (req, res) => {
    try {
        // Supprimer d'abord les messages liés
        await db.execute('DELETE FROM messages WHERE conversation_id = ?', [req.params.id]);
        // Puis la conversation
        await db.execute('DELETE FROM conversations WHERE id = ?', [req.params.id]);
        res.json({ message: 'Conversation supprimée définitivement' });
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
        try {
            onlineVisitors[socket.id] = {
                ...data,
                socketId: socket.id,
                joinedAt: Date.now(),
                lastMessage: { text: null, sender: null, timestamp: null }
            };
            socket.join(data.visitorId);

            // Extract agent_id from siteKey (asad_key_X_live)
            let agentId = null;
            if (data.siteKey) {
                const match = data.siteKey.match(/asad_key_(\d+)_live/);
                if (match) agentId = parseInt(match[1]);
            }

            if (db) {
                let [convs] = await db.execute("SELECT id FROM conversations WHERE visitor_id = ? AND status = 'open'", [data.visitorId]);
                let conversationId;

                if (convs.length === 0) {
                    const [result] = await db.execute(
                        'INSERT INTO conversations (visitor_id, first_name, last_name, whatsapp, problem, agent_id) VALUES (?, ?, ?, ?, ?, ?)',
                        [data.visitorId, data.firstName || null, data.lastName || null, data.whatsapp || null, data.problem || null, agentId]
                    );
                    conversationId = result.insertId;
                } else {
                    conversationId = convs[0].id;
                    await db.execute(
                        'UPDATE conversations SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), whatsapp = COALESCE(?, whatsapp), problem = COALESCE(?, problem), agent_id = COALESCE(agent_id, ?) WHERE id = ?',
                        [data.firstName || null, data.lastName || null, data.whatsapp || null, data.problem || null, agentId, conversationId]
                    );
                }

                socket.conversationId = conversationId;
                const [history] = await db.execute('SELECT sender_type as sender, content as text, created_at as timestamp FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [conversationId]);
                socket.emit('chat_history', history);
            }

            io.to('agents_room').emit('visitor_list', Object.values(onlineVisitors));
        } catch (err) {
            console.error('[Socket] Error in register_visitor:', err.message);
        }
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

                await db.execute("INSERT INTO messages (conversation_id, sender_type, content) VALUES (?, 'visitor', ?)", [socket.conversationId, data.text]);

                visitor.lastMessage = { text: data.text, sender: 'visitor', timestamp: Date.now() };
                io.to('agents_room').emit('visitor_list', Object.values(onlineVisitors));
                io.to('agents_room').emit('visitor_message', { visitorId: visitor.visitorId, text: data.text, timestamp: Date.now(), isMuted });

                if (socket.conversationId) {
                    const [convDetails] = await db.execute('SELECT agent_id FROM conversations WHERE id = ?', [socket.conversationId]);
                    if (convDetails.length > 0 && convDetails[0].agent_id) {
                        const agentId = convDetails[0].agent_id;
                        const [agentSettings] = await db.execute('SELECT email_notifications, whatsapp_notifications, whatsapp_number FROM settings WHERE user_id = ?', [agentId]);
                        const [agentProfile] = await db.execute('SELECT email FROM users WHERE id = ?', [agentId]);

                        if (agentSettings.length > 0) {
                            const { email_notifications, whatsapp_notifications, whatsapp_number } = agentSettings[0];
                            const agentEmail = agentProfile.length > 0 ? agentProfile[0].email : process.env.SMTP_USER;

                            if (email_notifications) {
                                sendNotificationEmail(visitor.visitorId, data.text, agentEmail, agentSettings[0].brevo_api_key, agentEmail);
                            }
                            if (whatsapp_notifications && whatsapp_number) {
                                sendWhatsAppNotification(visitor.visitorId, data.text, whatsapp_number, agentSettings[0].callmebot_api_key);
                            }

                        }
                    } else if (!isMuted) {
                        // Fallback logic if no agent assigned yet
                        sendNotificationEmail(visitor.visitorId, data.text);
                        sendWhatsAppNotification(visitor.visitorId, data.text);
                    }
                }

                handleBotAction(visitor.visitorId, data.text, socket.conversationId);
            } catch (err) {
                console.error('[Socket] Erreur sauvegarde message:', err.message);
            }
        }
    });

    socket.on('agent_message', async (data) => {
        try {
            if (db) {
                let [convs] = await db.execute("SELECT id FROM conversations WHERE visitor_id = ? AND status = 'open'", [data.visitorId]);
                if (convs.length > 0) {
                    await db.execute("INSERT INTO messages (conversation_id, sender_type, content) VALUES (?, 'agent', ?)", [convs[0].id, data.text]);

                    const visitorSocket = Object.keys(onlineVisitors).find(key => onlineVisitors[key].visitorId === data.visitorId);
                    if (visitorSocket) {
                        onlineVisitors[visitorSocket].isBotActive = false;
                        onlineVisitors[visitorSocket].lastMessage = { text: data.text, sender: 'agent', timestamp: Date.now() };
                        io.to('agents_room').emit('visitor_list', Object.values(onlineVisitors));
                    }
                }
            }
            io.to(data.visitorId).emit('agent_message', { text: data.text, timestamp: Date.now() });
        } catch (err) {
            console.error('[Socket] Error in agent_message:', err.message);
        }
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
