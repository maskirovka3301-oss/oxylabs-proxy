import fs from 'fs';
import net from 'net';
import tls from 'tls';

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const OXYLABS_CONFIG = config.oxylabs;
const LOCAL_CONFIG = config.local;

console.log('Configuration loaded:', {
    oxylabs: `${OXYLABS_CONFIG.host}:${OXYLABS_CONFIG.port}`,
    country: OXYLABS_CONFIG.country,
    local: `${LOCAL_CONFIG.host}:${LOCAL_CONFIG.port}`
});

// Create SOCKS5 server
const server = net.createServer((clientSocket) => {
    const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    console.log(`[CONNECTION] New client: ${clientAddr}`);
    
    let buffer = Buffer.alloc(0);
    let stage = 'auth';
    let targetHost = null;
    let targetPort = null;
    let oxylabsSocket = null;
    
    clientSocket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        
        if (stage === 'auth' && buffer.length >= 2) {
            // SOCKS5 authentication handshake
            const version = buffer[0];
            const nMethods = buffer[1];
            
            if (version !== 0x05) {
                console.error(`[ERROR] Invalid SOCKS version: ${version}`);
                clientSocket.end();
                return;
            }
            
            // Respond with no authentication required
            const response = Buffer.from([0x05, 0x00]);
            clientSocket.write(response);
            
            // Move to request stage
            stage = 'request';
            buffer = buffer.slice(2 + nMethods);
            
            // Process if we have enough data for request
            if (buffer.length >= 4) {
                processRequest();
            }
        } 
        else if (stage === 'request') {
            processRequest();
        }
        else if (stage === 'tunnel' && oxylabsSocket && !oxylabsSocket.destroyed) {
            // Forward data to Oxylabs
            oxylabsSocket.write(chunk);
        }
        
        function processRequest() {
            if (buffer.length < 4) return;
            
            const version = buffer[0];
            const cmd = buffer[1];
            const atyp = buffer[3];
            
            if (version !== 0x05) {
                console.error(`[ERROR] Invalid version in request: ${version}`);
                sendError();
                return;
            }
            
            if (cmd !== 0x01) { // Only CONNECT supported
                console.error(`[ERROR] Unsupported command: ${cmd}`);
                sendError();
                return;
            }
            
            let offset = 4;
            
            // Parse address
            switch (atyp) {
                case 0x01: // IPv4
                    if (buffer.length < offset + 4) return;
                    targetHost = Array.from(buffer.slice(offset, offset + 4)).join('.');
                    offset += 4;
                    break;
                case 0x03: // Domain name
                    if (buffer.length < offset + 1) return;
                    const domainLen = buffer[offset];
                    offset += 1;
                    if (buffer.length < offset + domainLen) return;
                    targetHost = buffer.slice(offset, offset + domainLen).toString();
                    offset += domainLen;
                    break;
                case 0x04: // IPv6
                    if (buffer.length < offset + 16) return;
                    const ipv6Parts = [];
                    for (let i = 0; i < 16; i += 2) {
                        ipv6Parts.push(buffer.readUInt16BE(offset + i).toString(16));
                    }
                    targetHost = ipv6Parts.join(':');
                    offset += 16;
                    break;
                default:
                    console.error(`[ERROR] Unsupported address type: ${atyp}`);
                    sendError();
                    return;
            }
            
            // Parse port
            if (buffer.length < offset + 2) return;
            targetPort = buffer.readUInt16BE(offset);
            
            console.log(`[REQUEST] ${targetHost}:${targetPort}`);
            
            // Clear buffer and connect
            buffer = Buffer.alloc(0);
            connectToOxylabs();
        }
        
        function sendError() {
            const response = Buffer.from([0x05, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
            clientSocket.write(response);
            clientSocket.end();
        }
        
        function sendSuccess() {
            // Bind to an arbitrary address/port
            const response = Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
            clientSocket.write(response);
        }
        
        function connectToOxylabs() {
            console.log(`[OXYLABS] Connecting to ${OXYLABS_CONFIG.host}:${OXYLABS_CONFIG.port}`);
            
            // Format credentials based on proxy type
            let proxyUsername, auth;
            
            if (OXYLABS_CONFIG.host.includes('dc.oxylabs.io')) {
                // Datacenter proxy format
                proxyUsername = `user-${OXYLABS_CONFIG.username}-country-${OXYLABS_CONFIG.country}`;
                auth = Buffer.from(`${proxyUsername}:${OXYLABS_CONFIG.password}`).toString('base64');
                console.log(`[AUTH] Using datacenter format: ${proxyUsername}`);
            } else {
                // Residential proxy format (pr.oxylabs.io)
                proxyUsername = `${OXYLABS_CONFIG.username}-cc-${OXYLABS_CONFIG.country}`;
                auth = Buffer.from(`${proxyUsername}:${OXYLABS_CONFIG.password}`).toString('base64');
                console.log(`[AUTH] Using residential format: ${proxyUsername}`);
            }
            
            // Determine if we need TLS or plain TCP
            const useTLS = OXYLABS_CONFIG.port === 8000 || OXYLABS_CONFIG.host.includes('dc.oxylabs.io');
            
            const connectOptions = {
                host: OXYLABS_CONFIG.host,
                port: OXYLABS_CONFIG.port
            };
            
            const connectCallback = () => {
                console.log(`[OXYLABS] Connected, sending CONNECT request`);
                
                // Send HTTP CONNECT request
                const connectReq = [
                    `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
                    `Host: ${targetHost}:${targetPort}`,
                    `Proxy-Authorization: Basic ${auth}`,
                    `Proxy-Connection: keep-alive`,
                    `User-Agent: Mozilla/5.0`,
                    '', ''
                ].join('\r\n');
                
                oxylabsSocket.write(connectReq);
            };
            
            // Create connection (TLS or plain)
            if (useTLS) {
                oxylabsSocket = tls.connect(connectOptions, connectCallback);
                oxylabsSocket.on('secureConnect', () => {
                    console.log(`[OXYLABS] TLS secure connection established`);
                });
            } else {
                oxylabsSocket = net.connect(connectOptions, connectCallback);
            }
            
            let responseBuffer = Buffer.alloc(0);
            let headerEnd = -1;
            
            oxylabsSocket.on('data', (data) => {
                responseBuffer = Buffer.concat([responseBuffer, data]);
                const response = responseBuffer.toString();
                
                // Check for end of HTTP headers
                if (headerEnd === -1) {
                    headerEnd = response.indexOf('\r\n\r\n');
                }
                
                if (headerEnd !== -1) {
                    const headers = response.substring(0, headerEnd);
                    const statusLine = headers.split('\r\n')[0];
                    console.log(`[OXYLABS] Response: ${statusLine}`);
                    
                    if (statusLine.includes('200 Connection established')) {
                        console.log(`[TUNNEL] ✅ Established to ${targetHost}:${targetPort}`);
                        
                        // Send success to client
                        sendSuccess();
                        
                        // Switch to tunnel mode
                        stage = 'tunnel';
                        
                        // Remove HTTP response from buffer
                        const remaining = responseBuffer.slice(headerEnd + 4);
                        
                        // Setup bidirectional pipe
                        setupTunnel();
                        
                        // Forward any remaining data
                        if (remaining.length > 0 && !clientSocket.destroyed) {
                            clientSocket.write(remaining);
                        }
                        
                        // Clear the response buffer
                        responseBuffer = Buffer.alloc(0);
                        headerEnd = -1;
                    } else if (statusLine.includes('407')) {
                        console.error(`[ERROR] ❌ Proxy Authentication Failed - Check credentials`);
                        console.error(`[ERROR] Username format: ${proxyUsername}`);
                        sendError();
                        cleanup();
                    } else if (statusLine.includes('403')) {
                        console.error(`[ERROR] ❌ Access Forbidden - Check country code or account status`);
                        sendError();
                        cleanup();
                    } else if (!statusLine.includes('200')) {
                        console.error(`[ERROR] ❌ Connection failed: ${statusLine}`);
                        sendError();
                        cleanup();
                    }
                }
            });
            
            oxylabsSocket.on('error', (err) => {
                console.error(`[ERROR] Oxylabs connection: ${err.message}`);
                sendError();
                cleanup();
            });
            
            function cleanup() {
                if (!clientSocket.destroyed) clientSocket.end();
                if (oxylabsSocket && !oxylabsSocket.destroyed) oxylabsSocket.destroy();
            }
        }
        
        function setupTunnel() {
            // Forward data from Oxylabs to client
            oxylabsSocket.on('data', (data) => {
                if (!clientSocket.destroyed) {
                    clientSocket.write(data);
                }
            });
            
            // Handle errors
            oxylabsSocket.on('error', (err) => {
                console.error(`[ERROR] Tunnel error: ${err.message}`);
                if (!clientSocket.destroyed) clientSocket.end();
            });
            
            clientSocket.on('error', (err) => {
                console.error(`[ERROR] Client error: ${err.message}`);
                if (oxylabsSocket && !oxylabsSocket.destroyed) oxylabsSocket.end();
            });
            
            clientSocket.on('close', () => {
                console.log(`[CLOSE] Client disconnected`);
                if (oxylabsSocket && !oxylabsSocket.destroyed) oxylabsSocket.end();
            });
            
            oxylabsSocket.on('close', () => {
                console.log(`[CLOSE] Oxylabs disconnected`);
                if (!clientSocket.destroyed) clientSocket.end();
            });
        }
    });
    
    clientSocket.on('error', (err) => {
        console.error(`[ERROR] Client socket error: ${err.message}`);
    });
});

server.listen(LOCAL_CONFIG.port, LOCAL_CONFIG.host, () => {
    console.log(`\n✅ SOCKS5 proxy running on ${LOCAL_CONFIG.host}:${LOCAL_CONFIG.port}`);
    console.log(`📡 Forwarding to Oxylabs (${OXYLABS_CONFIG.country})`);
    console.log(`🔐 Using ${OXYLABS_CONFIG.host}:${OXYLABS_CONFIG.port}`);
    console.log(`\n💡 Tip: Make sure to use dc.oxylabs.io:8000 for datacenter proxies\n`);
});