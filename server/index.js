const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const redis = require('redis');
const amqp = require('amqplib');

const app = express();
const port = 3000;

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket server on top of the HTTP server
const wss = new WebSocket.Server({ server });

// Initialize Redis clients
const redisPublisher = redis.createClient();
const redisSubscriber = redis.createClient();

redisPublisher.on('error', (err) => {
    console.error('Redis Publisher Error:', err);
});
redisSubscriber.on('error', (err) => {
    console.error('Redis Subscriber Error:', err);
});

// Connect Redis clients
async function connectRedis() {
    try {
        await redisPublisher.connect();
        await redisSubscriber.connect();
    } catch (error) {
        console.error('Error connecting to Redis:', error);
    }
}

// Initialize RabbitMQ connection and channel
let channel;
async function connectRabbitMQ() {
    try {
        const connection = await amqp.connect('amqp://localhost');
        channel = await connection.createChannel();
        await channel.assertQueue('notifications', { durable: true });
    } catch (error) {
        console.error('Error connecting to RabbitMQ:', error);
    }
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
    console.log('New client connected');
    ws.send('Connected to WebSocket server');

    ws.on('message', (message) => {
        console.log('Received:', message);
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

// Handle HTTP to WebSocket upgrade
app.use(express.json());

// Endpoint to trigger notifications
app.post('/send-notification', async (req, res) => {
    const { message } = req.body;
    try {
        if (!channel) {
            console.error('RabbitMQ channel is not connected');
            await connectRabbitMQ();
        }
        channel.sendToQueue('notifications', Buffer.from(message), { persistent: true });
        res.status(200).send('Notification sent');
    } catch (error) {
        console.error('Error publishing notification:', error);
        res.status(500).send('Failed to send notification');
    }
});

// Consume messages from RabbitMQ and broadcast to WebSocket clients
async function consumeMessages() {
    try {
        await connectRabbitMQ();
        channel.consume('notifications', (msg) => {
            if (msg !== null) {
                const message = msg.content.toString();
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(message);
                    }
                });
                channel.ack(msg);
            }
        });
    } catch (error) {
        console.error('Error consuming messages from RabbitMQ:', error);
    }
}

// Connect Redis clients and start consuming messages from RabbitMQ
connectRedis();
consumeMessages();

// Start the HTTP server
server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

// Handle shutdown gracefully
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    try {
        if (redisPublisher.isOpen) await redisPublisher.quit();
        if (redisSubscriber.isOpen) await redisSubscriber.quit();
        if (channel) await channel.close();
    } catch (error) {
        console.error('Error during shutdown:', error);
    }
    process.exit(0);
});
