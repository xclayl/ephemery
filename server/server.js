const express = require('express');
const redis = require("redis");
const { Server } = require('ws');
const { promisify } = require("util");

const path = require('path');
const { nanoid } = require('nanoid');

const { NODE_ENV, PORT, REDIS_HOST } = require('./config');

const ROOM_LENGTH = 12;
const ROOM_TTL = 120;
const CHANNEL_PREFIX = "eph:room";
const ROOM_TOKEN_PREFIX = `${CHANNEL_PREFIX}:room-token`;

const app = express();


// Open Redis publisher and subscribers
const publisher = redis.createClient({url: REDIS_HOST});
const subscriber = redis.createClient({url: REDIS_HOST});
// Promisify Redis methods:
const get = promisify(publisher.get).bind(publisher);
const set = promisify(publisher.set).bind(publisher);
const del = promisify(publisher.del).bind(publisher);
const expire = promisify(publisher.expire).bind(publisher);
const publish = promisify(publisher.publish).bind(publisher);
const psubscribe = promisify(subscriber.psubscribe).bind(subscriber);


// Serve static files from the React app
app.use(express.static(path.join(__dirname, '../client/build')));

// Create room
app.post('/api/room', async (req, res) => {
  const roomId = nanoid(ROOM_LENGTH);
  const roomToken = nanoid(32);
  // Put room token with EXP
  await set(`${ROOM_TOKEN_PREFIX}:${roomId}`, roomToken, 'EX', ROOM_TTL);
  res.json({ roomId, roomToken });
});

const server = app.listen(PORT);
console.log(`Express istening on port ${PORT} in ${NODE_ENV}`);


// Start web socket server
const wss = new Server({ server, path: "/room-io" });

// Room subscribers
// roomId => [ws]
let roomSubscribers = {}

// Send formatted message to client
const send = (ws, type, body) => {
  ws.send(JSON.stringify({type, body}));
}

const addRoomSubscriber = (roomId, client) => {
  if (!roomSubscribers[roomId]) {
    roomSubscribers[roomId] = [];
  }
  if (roomSubscribers[roomId].indexOf(client) < 0) {
    roomSubscribers[roomId].push(client);
  }
}

const removeRoomSubscriber = (roomId, client) => {
  const i = roomSubscribers.indexOf(client);
  if (i > -1) {
    roomSubscribers = roomSubscribers.splice(i, 1)
  }
}

wss.on('connection', (ws) => {
  let isHost = false;
  let isInvalid = false;

  ws.on('message', async (data) => {
    console.log(data, isHost);

    // Connection to room in invalid state
    if (isInvalid) {
      send(ws, "error", "invalid");
      return;
    }

    // Parse message data
    const { type, roomId, body } = JSON.parse(data);
    const roomKey = `${CHANNEL_PREFIX}:${roomId}`;
    
    // Open room channel / keep alive if not already present (or recent)
    if (type === 'host-keepalive') {
      const roomKey = await get(`${ROOM_TOKEN_PREFIX}:${roomId}`);
      if (roomKey === body) {
        isHost = true;
        expire(`${ROOM_TOKEN_PREFIX}:${roomId}`, ROOM_TTL);
        console.log(`Host keep alive for room ${roomId}`)
      } else {
        isInvalid = true;
        send(ws, "error", "invalid-room-key")
      }

    // Host send to room
    } else if (isHost && type === 'send-room') {
      await publish(`${CHANNEL_PREFIX}:${roomId}`, body)
      console.log(`Broadcast: [${CHANNEL_PREFIX}:${roomId}] ${body}`)

    // Guest enter a room an subscribe to messages
    } else if (!isHost && type === 'connect-guest') {
      console.log(`Guest connected to ${roomId}`)
      addRoomSubscriber(roomId, ws);

    }

  });

  // Close connection:
  //  Close room if host
  //  Remove subscriber entry if other
  ws.on('close', async () => {
    if (isHost) {
      await del(roomKey)
    } else {
      removeRoomSubscriber(roomId, ws);
    }
    console.log('Client disconnected')
  });

});

psubscribe(`${CHANNEL_PREFIX}:*`)
console.log(`psubscribed to [${CHANNEL_PREFIX}:*]`)
subscriber.on("pmessage", (pattern, channel, message) => {
  console.log("pmessage", channel, message);
  const roomId = channel.slice(CHANNEL_PREFIX.length + 1);
  console.log("looking for room subscribers for " + roomId);
  roomSubscribers[roomId]?.forEach((roomSubscriber) => {
    console.log(`broadcasting "${message}" to subscriber`)
    send(roomSubscriber, 'broadcast', message);
  })
  // wss.clients.forEach(client => {
  //   if (client.readyState === WebSocket.OPEN) {
  //     client.send(message);
  //   }
  // });
});

