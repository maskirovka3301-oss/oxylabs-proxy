import fs from 'fs';
import net from 'net';

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const OXYLABS_CONFIG = config.oxylabs;
const LOCAL_CONFIG = config.local;
const AUTH_CONFIG = config.auth;

console.log('Configuration loaded:', {
    oxylabs: `${OXYLABS_CONFIG.host}:${OXYLABS_CONFIG.port}`,
    country: OXYLABS_CONFIG.country,
    local: `${LOCAL_CONFIG.host}:${LOCAL_CONFIG.port}`,
    authEnabled: AUTH_CONFIG.enabled
});

// SOCKS5 protocol constants
const SOCKS_VERSION = 0x05;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_CONNECTION_NOT_ALLOWED = 0x02;
const REP_NETWORK_UNREACHABLE = 0x03;
const REP_HOST_UNREACHABLE = 0x04;
const REP_CONNECTION_REFUSED = 0x05;
const REP_TTL_EXPIRED = 0x06;
const REP_COMMAND_NOT_SUPPORTED = 0x07;
const REP_ADDRESS_TYPE_NOT_SUPPORTED = 0x08;

// Create SOCKS5 server
const server = net.createServer((clientSocket) => {
    const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    console.log(`[CONNECTION] New client connected: ${clientAddr}`);
    
    let stage = 'auth';
    let targetHost = null;
    let targetPort = null;
    let oxylabsSocket = null;
    
    // Handle client data
    clientSocket.on('data', (data) => {
        if (stage === 'auth') {
            handleAuthentication(clientSocket, data);
        } else if (stage === 'request') {
            handleRequest(clientSocket, data);
        } else if (stage === 'tunnel') {
            // Forward data to Oxylabs
            if (oxylabsSocket && !oxylabsSocket.destroyed) {
                oxylabsSocket.write(data);
            }
        }
    });
    
    // Handle client errors
    clientSocket.on('error', (err) => {
        console.error(`[ERROR] Client ${clientAddr} error:`, err.message);
        if (oxylabsSocket && !oxylabsSocket.destroyed) {
            oxylabsSocket.destroy();
        }
    });
    
    // Handle client disconnect
    clientSocket.on('close', () => {
        console.log(`[DISCONNECT] Client ${clientAddr} disconnected`);
        if (oxylabsSocket && !oxylabsSocket.destroyed) {
            oxylabsSocket.destroy();
        }
    });
    
    // Handle authentication phase
    function handleAuthentication(socket, data) {
        if (data.length < 2) {
            console.error('[AUTH] Invalid auth packet');
            socket.end();
            return;
        }
        
        const version = data[0];
        const nMethods = data[1];
        
        if (version !== SOCKS_VERSION) {
            console.error(`[AUTH] Unsupported SOCKS version: ${version}`);
            socket.end();
            return;
        }
        
        // Check available authentication methods
        const methods = data.slice(2, 2 + nMethods);
        
        if (AUTH_CONFIG.enabled) {
            // Username/Password authentication required
            if (methods.includes(0x02)) {
                // Send auth method selection: 0x02 = username/password
                socket.write(Buffer.from([SOCKS_VERSION, 0x02]));
                stage = 'auth_credentials';
                console.log('[AUTH] Requesting username/password');
            } else {
                // No acceptable auth method
                console.error('[AUTH] No acceptable auth method found');
                socket.write(Buffer.from([SOCKS_VERSION, 0xFF]));
                socket.end();
            }
        } else {
            // No authentication
            if (methods.includes(0x00)) {
                socket.write(Buffer.from([SOCKS_VERSION, 0x00]));
                stage = 'request';
                console.log('[AUTH] No authentication required');
            } else {
                console.error('[AUTH] No auth method 0x00 available');
                socket.write(Buffer.from([SOCKS_VERSION, 0xFF]));
                socket.end();
            }
        }
    }
    
    // Handle username/password authentication
    function handleAuthCredentials(socket, data) {
        if (data.length < 2) {
            console.error('[AUTH] Invalid credentials packet');
            socket.end();
            return;
        }
        
        const version = data[0];
        const usernameLen = data[1];
        const username = data.slice(2, 2 + usernameLen).toString();
        const passwordLen = data[2 + usernameLen];
        const password = data.slice(3 + usernameLen, 3 + usernameLen + passwordLen).toString();
        
        if (username === AUTH_CONFIG.username && password === AUTH_CONFIG.password) {
            console.log(`[AUTH] Authentication successful for user: ${username}`);
            socket.write(Buffer.from([0x01, 0x00])); // Success
            stage = 'request';
        } else {
            console.error(`[AUTH] Authentication failed for user: ${username}`);
            socket.write(Buffer.from([0x01, 0x01])); // Failure
            socket.end();
        }
    }
    
    // Handle SOCKS5 request
    function handleRequest(socket, data) {
        if (data.length < 4) {
            console.error('[REQUEST] Invalid request packet');
            sendReply(socket, REP_GENERAL_FAILURE, ATYP_IPV4, '0.0.0.0', 0);
            socket.end();
            return;
        }
        
        const version = data[0];
        const cmd = data[1];
        const reserved = data[2];
        const atyp = data[3];
        
        if (version !== SOCKS_VERSION) {
            console.error(`[REQUEST] Unsupported SOCKS version: ${version}`);
            sendReply(socket, REP_GENERAL_FAILURE, ATYP_IPV4, '0.0.0.0', 0);
            socket.end();
            return;
        }
        
        if (cmd !== CMD_CONNECT) {
            console.error(`[REQUEST] Unsupported command: ${cmd} (only CONNECT supported)`);
            sendReply(socket, REP_COMMAND_NOT_SUPPORTED, ATYP_IPV4, '0.0.0.0', 0);
            socket.end();
            return;
        }
        
        let offset = 4;
        
        // Parse address
        switch (atyp) {
            case ATYP_IPV4: // IPv4
                if (data.length < offset + 4) {
                    sendReply(socket, REP_GENERAL_FAILURE, ATYP_IPV4, '0.0.0.0', 0);
                    socket.end();
                    return;
                }
                targetHost = Array.from(data.slice(offset, offset + 4)).join('.');
                offset += 4;
                break;
                
            case ATYP_DOMAIN: // Domain name
                if (data.length < offset + 1) {
                    sendReply(socket, REP_GENERAL_FAILURE, ATYP_IPV4, '0.0.0.0', 0);
                    socket.end();
                    return;
                }
                const domainLen = data[offset];
                offset += 1;
                if (data.length < offset + domainLen) {
                    sendReply(socket, REP_GENERAL_FAILURE, ATYP_IPV4, '0.0.0.0', 0);
                    socket.end();
                    return;
                }
                targetHost = data.slice(offset, offset + domainLen).toString();
                offset += domainLen;
                break;
                
            case ATYP_IPV6: // IPv6
                if (data.length < offset + 16) {
                    sendReply(socket, REP_GENERAL_FAILURE, ATYP_IPV4, '0.0.0.0', 0);
                    socket.end();
                    return;
                }
                const ipv6Parts = [];
                for (let i = 0; i < 16; i += 2) {
                    ipv6Parts.push(data.readUInt16BE(offset + i).toString(16));
                }
                targetHost = ipv6Parts.join(':');
                offset += 16;
                break;
                
            default:
                console.error(`[REQUEST] Unsupported address type: ${atyp}`);
                sendReply(socket, REP_ADDRESS_TYPE_NOT_SUPPORTED, ATYP_IPV4, '0.0.0.0', 0);
                socket.end();
                return;
        }
        
        // Parse port
        if (data.length < offset + 2) {
            sendReply(socket, REP_GENERAL_FAILURE, ATYP_IPV4, '0.0.0.0', 0);
            socket.end();
            return;
        }
        targetPort = data.readUInt16BE(offset);
        
        console.log(`[REQUEST] Target: ${targetHost}:${targetPort}`);
        
        // Connect to Oxylabs proxy
        connectToOxylabs(socket, targetHost, targetPort);
    }
    
    // Connect to Oxylabs proxy
    function connectToOxylabs(clientSocket, targetHost, targetPort) {
        console.log(`[OXYLABS] Connecting to ${OXYLABS_CONFIG.host}:${OXYLABS_CONFIG.port}`);
        
        oxylabsSocket = net.createConnection({
            host: OXYLABS_CONFIG.host,
            port: OXYLABS_CONFIG.port
        }, () => {
            console.log(`[OXYLABS] Connected, sending SOCKS5 handshake`);
            // Send SOCKS5 handshake to Oxylabs
            sendOxylabsHandshake(clientSocket, targetHost, targetPort);
        });
        
        oxylabsSocket.on('error', (err) => {
            console.error(`[OXYLABS] Connection error:`, err.message);
            sendReply(clientSocket, REP_NETWORK_UNREACHABLE, ATYP_IPV4, '0.0.0.0', 0);
            clientSocket.end();
        });
    }
    
    // Send SOCKS5 handshake to Oxylabs
    function sendOxylabsHandshake(clientSocket, targetHost, targetPort) {
        // Build authentication string
        const authString = `${OXYLABS_CONFIG.username}-cc-${OXYLABS_CONFIG.country}:${OXYLABS_CONFIG.password}`;
        const authBuffer = Buffer.from(authString);
        
        // Step 1: Send auth method selection (username/password)
        const authMethodPacket = Buffer.from([0x05, 0x01, 0x02]); // SOCKS5, 1 method, method=0x02
        oxylabsSocket.write(authMethodPacket);
        
        oxylabsSocket.once('data', (data) => {
            if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x02) {
                console.error('[OXYLABS] Auth method not supported');
                sendReply(clientSocket, REP_GENERAL_FAILURE, ATYP_IPV4, '0.0.0.0', 0);
                clientSocket.end();
                oxylabsSocket.destroy();
                return;
            }
            
            // Step 2: Send username/password
            const userPassPacket = Buffer.concat([
                Buffer.from([0x01]), // Version
                Buffer.from([authBuffer.length]), // Username length
                authBuffer, // Username (contains country)
                Buffer.from([0x00]), // Password length (empty)
                Buffer.from([]) // Empty password
            ]);
            
            oxylabsSocket.write(userPassPacket);
            
            oxylabsSocket.once('data', (data) => {
                if (data.length < 2 || data[0] !== 0x01 || data[1] !== 0x00) {
                    console.error('[OXYLABS] Authentication failed');
                    sendReply(clientSocket, REP_CONNECTION_NOT_ALLOWED, ATYP_IPV4, '0.0.0.0', 0);
                    clientSocket.end();
                    oxylabsSocket.destroy();
                    return;
                }
                
                console.log('[OXYLABS] Authentication successful');
                
                // Step 3: Send CONNECT request
                sendOxylabsConnectRequest(clientSocket, targetHost, targetPort);
            });
        });
        
        oxylabsSocket.on('error', (err) => {
            console.error('[OXYLABS] Socket error during handshake:', err.message);
            clientSocket.end();
        });
    }
    
    // Send CONNECT request to Oxylabs
    function sendOxylabsConnectRequest(clientSocket, targetHost, targetPort) {
        // Build SOCKS5 CONNECT request
        let addressPacket;
        let atyp;
        
        // Check if targetHost is IP address or domain
        const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(targetHost);
        const isIPv6 = targetHost.includes(':');
        
        if (isIPv4) {
            atyp = ATYP_IPV4;
            addressPacket = Buffer.from(targetHost.split('.').map(Number));
        } else if (isIPv6) {
            atyp = ATYP_IPV6;
            // Simplified IPv6 parsing (for real use, parse properly)
            addressPacket = Buffer.alloc(16);
            // This is a simplification - proper IPv6 parsing would be more complex
        } else {
            atyp = ATYP_DOMAIN;
            const domainBuffer = Buffer.from(targetHost);
            addressPacket = Buffer.concat([
                Buffer.from([domainBuffer.length]),
                domainBuffer
            ]);
        }
        
        const portBuffer = Buffer.alloc(2);
        portBuffer.writeUInt16BE(targetPort, 0);
        
        const connectPacket = Buffer.concat([
            Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0x00, atyp]),
            addressPacket,
            portBuffer
        ]);
        
        oxylabsSocket.write(connectPacket);
        
        oxylabsSocket.once('data', (data) => {
            if (data.length < 4) {
                console.error('[OXYLABS] Invalid CONNECT response');
                sendReply(clientSocket, REP_GENERAL_FAILURE, ATYP_IPV4, '0.0.0.0', 0);
                clientSocket.end();
                oxylabsSocket.destroy();
                return;
            }
            
            const rep = data[1];
            
            if (rep === REP_SUCCESS) {
                console.log(`[TUNNEL] Established to ${targetHost}:${targetPort} via Oxylabs`);
                
                // Send success response to client
                sendReply(clientSocket, REP_SUCCESS, ATYP_IPV4, '0.0.0.0', 0);
                
                // Enter tunnel mode
                stage = 'tunnel';
                
                // Start bidirectional forwarding
                setupTunnel(clientSocket, oxylabsSocket);
            } else {
                console.error(`[OXYLABS] CONNECT failed with code: ${rep}`);
                sendReply(clientSocket, rep, ATYP_IPV4, '0.0.0.0', 0);
                clientSocket.end();
                oxylabsSocket.destroy();
            }
        });
    }
    
    // Set up bidirectional tunnel between client and Oxylabs
    function setupTunnel(clientSocket, oxylabsSocket) {
        // Forward data from Oxylabs to client
        oxylabsSocket.on('data', (data) => {
            if (!clientSocket.destroyed) {
                clientSocket.write(data);
            }
        });
        
        // Handle Oxylabs socket end
        oxylabsSocket.on('end', () => {
            console.log('[TUNNEL] Oxylabs connection ended');
            if (!clientSocket.destroyed) {
                clientSocket.end();
            }
        });
        
        // Handle Oxylabs socket errors
        oxylabsSocket.on('error', (err) => {
            console.error('[TUNNEL] Oxylabs socket error:', err.message);
            if (!clientSocket.destroyed) {
                clientSocket.end();
            }
        });
        
        // Handle client socket end
        clientSocket.on('end', () => {
            console.log('[TUNNEL] Client connection ended');
            if (!oxylabsSocket.destroyed) {
                oxylabsSocket.end();
            }
        });
    }
    
    // Send SOCKS5 reply to client
    function sendReply(socket, rep, atyp, bindHost, bindPort) {
        let addressPacket;
        
        switch (atyp) {
            case ATYP_IPV4:
                addressPacket = Buffer.from(bindHost.split('.').map(Number));
                break;
            case ATYP_DOMAIN:
                addressPacket = Buffer.concat([
                    Buffer.from([bindHost.length]),
                    Buffer.from(bindHost)
                ]);
                break;
            default:
                addressPacket = Buffer.from([0, 0, 0, 0]);
        }
        
        const portBuffer = Buffer.alloc(2);
        portBuffer.writeUInt16BE(bindPort, 0);
        
        const reply = Buffer.concat([
            Buffer.from([SOCKS_VERSION, rep, 0x00, atyp]),
            addressPacket,
            portBuffer
        ]);
        
        socket.write(reply);
    }
});

// Handle server errors
server.on('error', (err) => {
    console.error('[SERVER] Error:', err.message);
});

// Start listening
server.listen(LOCAL_CONFIG.port, LOCAL_CONFIG.host, () => {
    console.log(`\n[SUCCESS] SOCKS5 proxy server running on ${LOCAL_CONFIG.host}:${LOCAL_CONFIG.port}`);
    console.log(`[CONFIG] Forwarding through Oxylabs (${OXYLABS_CONFIG.country})`);
    console.log(`[CONFIG] Oxylabs endpoint: ${OXYLABS_CONFIG.host}:${OXYLABS_CONFIG.port}`);
    if (AUTH_CONFIG.enabled) {
        console.log(`[AUTH] Local authentication enabled (username/password)`);
    } else {
        console.log(`[AUTH] Local authentication disabled`);
    }
    console.log(`\n[READY] Waiting for connections...\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n[SHUTDOWN] Received SIGINT, closing server...');
    server.close(() => {
        console.log('[SHUTDOWN] Server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n\n[SHUTDOWN] Received SIGTERM, closing server...');
    server.close(() => {
        console.log('[SHUTDOWN] Server closed');
        process.exit(0);
    });
});