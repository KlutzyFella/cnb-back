const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // frontend URL here later 
        methods: ["GET", "POST"],
    },
});

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.get("/", (req, res) => {
    res.send("Backend is running!");
});

// lobbies[lobbyId] = [
//   { userId: socket.id, 
//      input: null,
//      secretNumber: null,
//      attempts: 0,
//      hasGuessedThisRound: false }
const lobbies = {};

// server.js, at top
function getFeedback(secret, guess) {
    const statuses = Array(4).fill("absent");
    const secretCount = {};

    // 1) mark bulls
    for (let i = 0; i < 4; i++) {
        if (guess[i] === secret[i]) {
            statuses[i] = "correct";
        } else {
            secretCount[secret[i]] = (secretCount[secret[i]] || 0) + 1;
        }
    }

    // 2) mark cows
    for (let i = 0; i < 4; i++) {
        if (statuses[i] === "correct") continue;
        const g = guess[i];
        if (secretCount[g] > 0) {
            statuses[i] = "present";
            secretCount[g]--;
        }
    }

    return statuses;
}


io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    // on user join lobby
    socket.on("joinLobby", (lobbyId) => {
        if (!lobbies[lobbyId]) {
            lobbies[lobbyId] = [];
        }

        // add user to the lobby
        socket.join(lobbyId);
        console.log(`${socket.id} joined lobby: ${lobbyId}`);

        // check if user is already in the lobby
        const isUserInLobby = lobbies[lobbyId].some((user) => user.userId === socket.id);
        if (!isUserInLobby) {
            // add user to the lobby
            const currentUserCount = lobbies[lobbyId].length;

            // if there are 3 users in the lobby, redirect the third user to the home page
            if (currentUserCount >= 2) {
                // redirect the third user to the home page
                console.log(`Redirecting third user: ${socket.id}`);
                // emit redirectToHome event to the third user
                socket.emit("redirectToHome");
                socket.disconnect(true);
            } else {
                // add user to the lobby with a default input of `null`
                lobbies[lobbyId].push({
                    userId: socket.id,
                    input: null,
                    secretNumber: null,
                    hasGuessedThisRound: false
                });

                // Send current lobby state to the joining user
                socket.emit("lobbyState", lobbies[lobbyId]);

                // Notify all users in the lobby of the current count
                io.to(lobbyId).emit("updateUserCount", lobbies[lobbyId].length);
            }
        }
    });


    // on user input
    socket.on("userInput", ({ lobbyId, input }) => {
        const users = lobbies[lobbyId];
        if (!users) return;

        // mark this user's guess this round
        const me = users.find(u => u.userId === socket.id);
        if (!me) return;
        me.input = input;
        me.hasGuessedThisRound = true;

        // find opponent
        const opponent = users.find(u => u.userId !== socket.id);
        if (opponent && opponent.secretNumber) {
            // 1. compute per-digit feedback
            const statuses = getFeedback(opponent.secretNumber, input);

            // 2. send that back to the guesser
            socket.emit("guessResult", { statuses });

            // 3. count bulls for game-over
            const bulls = statuses.filter(s => s === "correct").length;
            if (bulls === 4) {
                io.to(lobbyId).emit("gameOver", { winner: socket.id });
                return;
            }
        }

        // once both have guessed, reset and start next round
        if (users.length === 2 && users.every(u => u.hasGuessedThisRound)) {
            users.forEach(u => u.hasGuessedThisRound = false);
            console.log(`🔄 [server] nextRound for lobby ${lobbyId}`);
            io.to(lobbyId).emit("nextRound");
        }
    });


    // on user disconnect
    socket.on("disconnecting", () => {
        const userRooms = Array.from(socket.rooms).filter((room) => room !== socket.id);

        for (const lobbyId of userRooms) {
            if (lobbies[lobbyId]) {
                lobbies[lobbyId] = lobbies[lobbyId].filter((user) => user.userId !== socket.id);
                io.to(lobbyId).emit("updateUserCount", lobbies[lobbyId].length);

                if (lobbies[lobbyId].length === 0) {
                    delete lobbies[lobbyId];
                }
            }
        }
        console.log(`User disconnected: ${socket.id}`);
    });

    // once user sets secret number
    socket.on("setSecret", ({ lobbyId, secret }) => {
        if (lobbies[lobbyId]) {
            const user = lobbies[lobbyId].find(u => u.userId === socket.id);
            if (user) {
                user.secretNumber = secret;
                console.log(`User ${socket.id} set secret number in lobby ${lobbyId}`);

                const allSet = lobbies[lobbyId].length === 2 && lobbies[lobbyId].every(u => u.secretNumber);

                if (allSet) {
                    io.to(lobbyId).emit("startGame");
                }
            }
        }
    });

    // on user reset game
    socket.on("restartGame", ({ lobbyId }) => {
        const users = lobbies[lobbyId];
        if (!users) return;

        // reset each player’s state
        users.forEach((u) => {
            u.input = null;
            u.secretNumber = null;
            u.hasGuessedThisRound = false;
        });

        console.log(`[server] lobby ${lobbyId} restarted`);
        // let all clients know they can start over
        io.to(lobbyId).emit("gameRestarted");
    });

});


const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
});
