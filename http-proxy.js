import fs from 'fs';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import net from 'net';
import tls from 'tls';

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const OXYLABS_CONFIG = config.oxylabs;
const LOCAL_CONFIG = config.local;
const AUTH_CONFIG = config.auth;

// Determine proxy type and authentication format
const isDatacenter = OXYLABS_CONFIG.host.includes('dc.oxylabs.io') || OXYLABS_CONFIG.port === 8000;
const useTLS = OXYLABS_CONFIG.port === 8000 || OXYLABS_CONFIG.host.includes('dc.oxylabs.io');

// Format credentials based on proxy type
function getAuthHeader() {
    let proxyUsername;
    if (isDatacenter) {
        // Datacenter proxy format (dc.oxylabs.io:8000)
        proxyUsername = `user-${OXYLABS_CONFIG.username}-country-${OXYLABS_CONFIG.country}`;
    } else {
        // Residential proxy format (pr.oxylabs.io:7777)
        proxyUsername = `${OXYLABS_CONFIG.username}-cc-${OXYLABS_CONFIG.country}`;
    }
    const auth = Buffer.from(`${proxyUsername}:${OXYLABS_CONFIG.password}`).toString('base64');
    console.log(`[AUTH] Using format: ${proxyUsername}`);
    return auth;
}

// Create HTTP proxy server
const server = http.createServer((clientReq, clientRes) => {
    console.log(`[HTTP] ${clientReq.method} ${clientReq.url}`);
    
    try {
        // Parse target URL
        const url = new URL(clientReq.url, `http://${clientReq.headers.host}`);
        const auth = getAuthHeader();
        
        // Prepare request options for Oxylabs
        const options = {
            hostname: OXYLABS_CONFIG.host,
            port: OXYLABS_CONFIG.port,
            path: clientReq.url,
            method: clientReq.method,
            headers: {
                ...clientReq.headers,
                'Host': url.host,
                'Proxy-Authorization': `Basic ${auth}`,
                'Proxy-Connection': 'keep-alive',
                'User-Agent': clientReq.headers['user-agent'] || 'Mozilla/5.0'
            },
            rejectUnauthorized: false
        };
        
        // Remove problematic headers
        delete options.headers['proxy-connection'];
        delete options.headers['proxy-authorization'];
        
        const makeRequest = (requestOptions) => {
            let proxyReq;
            
            if (useTLS) {
                proxyReq = https.request(requestOptions, (proxyRes) => {
                    console.log(`[HTTP] Response: ${proxyRes.statusCode}`);
                    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
                    proxyRes.pipe(clientRes);
                });
            } else {
                proxyReq = http.request(requestOptions, (proxyRes) => {
                    console.log(`[HTTP] Response: ${proxyRes.statusCode}`);
                    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
                    proxyRes.pipe(clientRes);
                });
            }
            
            proxyReq.on('error', (err) => {
                console.error(`[HTTP] Request error:`, err.message);
                if (!clientRes.headersSent) {
                    clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
                }
                clientRes.end(`Proxy error: ${err.message}`);
            });
            
            clientReq.pipe(proxyReq);
        };
        
        makeRequest(options);
        
    } catch (err) {
        console.error(`[HTTP] Parse error:`, err.message);
        clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
        clientRes.end(`Invalid request: ${err.message}`);
    }
});

// Handle CONNECT method for HTTPS tunnels
server.on('connect', (req, clientSocket, head) => {
    console.log(`[CONNECT] ${req.url}`);
    
    const [host, port] = req.url.split(':');
    const auth = getAuthHeader();
    
    console.log(`[CONNECT] Tunneling to ${host}:${port}`);
    
    // Create connection to Oxylabs (TLS or plain)
    const connectOptions = {
        host: OXYLABS_CONFIG.host,
        port: OXYLABS_CONFIG.port,
        rejectUnauthorized: false
    };
    
    const connectCallback = () => {
        console.log(`[CONNECT] Connected to Oxylabs`);
        
        // Send CONNECT request to Oxylabs
        const connectRequest = [
            `CONNECT ${host}:${port} HTTP/1.1`,
            `Host: ${host}:${port}`,
            `Proxy-Authorization: Basic ${auth}`,
            `Proxy-Connection: keep-alive`,
            `User-Agent: local-proxy/1.0`,
            ``, ``
        ].join('\r\n');
        
        proxySocket.write(connectRequest);
    };
    
    let proxySocket;
    if (useTLS) {
        proxySocket = tls.connect(connectOptions, connectCallback);
        proxySocket.on('secureConnect', () => {
            console.log(`[CONNECT] TLS secure connection established`);
        });
    } else {
        proxySocket = net.connect(connectOptions, connectCallback);
    }
    
    let responseBuffer = Buffer.alloc(0);
    let headerEnd = -1;
    
    proxySocket.on('data', (data) => {
        responseBuffer = Buffer.concat([responseBuffer, data]);
        const response = responseBuffer.toString();
        
        // Check for end of HTTP headers
        if (headerEnd === -1) {
            headerEnd = response.indexOf('\r\n\r\n');
        }
        
        if (headerEnd !== -1) {
            const headers = response.substring(0, headerEnd);
            const statusLine = headers.split('\r\n')[0];
            console.log(`[CONNECT] Oxylabs response: ${statusLine}`);
            
            if (statusLine.includes('200 Connection established')) {
                // Send success to client
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                
                // Remove CONNECT response from stream
                const remainingData = responseBuffer.slice(headerEnd + 4);
                
                // Setup bidirectional tunnel
                clientSocket.pipe(proxySocket);
                proxySocket.pipe(clientSocket);
                
                // Forward any remaining data
                if (remainingData.length > 0) {
                    clientSocket.write(remainingData);
                }
                
                console.log(`[CONNECT] ✅ Tunnel established to ${host}:${port}`);
                
                // Clear buffer
                responseBuffer = Buffer.alloc(0);
                headerEnd = -1;
                
                // Handle errors
                clientSocket.on('error', (err) => {
                    console.error(`[CONNECT] Client socket error:`, err.message);
                    if (!proxySocket.destroyed) proxySocket.end();
                });
                
                proxySocket.on('error', (err) => {
                    console.error(`[CONNECT] Proxy socket error:`, err.message);
                    if (!clientSocket.destroyed) clientSocket.end();
                });
                
                clientSocket.on('close', () => {
                    console.log(`[CONNECT] Client closed connection`);
                    if (!proxySocket.destroyed) proxySocket.end();
                });
                
                proxySocket.on('close', () => {
                    console.log(`[CONNECT] Proxy closed connection`);
                    if (!clientSocket.destroyed) clientSocket.end();
                });
                
            } else if (statusLine.includes('407')) {
                console.error(`[CONNECT] ❌ Proxy Authentication Failed`);
                console.error(`[CONNECT] Check username format and credentials`);
                clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
                proxySocket.end();
            } else if (statusLine.includes('403')) {
                console.error(`[CONNECT] ❌ Access Forbidden - Check country code or account`);
                clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
                proxySocket.end();
            } else {
                console.error(`[CONNECT] ❌ Failed to establish tunnel: ${statusLine}`);
                clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
                proxySocket.end();
            }
        }
    });
    
    proxySocket.on('error', (err) => {
        console.error(`[CONNECT] Proxy connection error:`, err.message);
        if (!clientSocket.destroyed) {
            clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
    });
    
    clientSocket.on('error', (err) => {
        console.error(`[CONNECT] Client connection error:`, err.message);
        if (!proxySocket.destroyed) proxySocket.end();
    });
});

// Get local port from config or use defaults
const localPort = LOCAL_CONFIG.port || (isDatacenter ? 8080 : 8081);
const localHost = LOCAL_CONFIG.host || '127.0.0.1';

server.listen(localPort, localHost, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ HTTP proxy server running on ${localHost}:${localPort}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📡 Forwarding through Oxylabs (${OXYLABS_CONFIG.country})`);
    console.log(`🔐 Endpoint: ${OXYLABS_CONFIG.host}:${OXYLABS_CONFIG.port}`);
    console.log(`🏷️  Proxy type: ${isDatacenter ? 'Datacenter' : 'Residential'}`);
    console.log(`🔒 Connection: ${useTLS ? 'TLS/SSL' : 'Plain TCP'}`);
    console.log(`🔑 Auth format: ${isDatacenter ? 'user-{user}-country-{country}' : '{user}-cc-{country}'}`);
    console.log(`${'='.repeat(60)}`);
    
    if (AUTH_CONFIG.enabled) {
        console.log(`🔐 Local authentication: ENABLED`);
    } else {
        console.log(`🔓 Local authentication: DISABLED`);
    }
    console.log(`\n💡 Test with: curl --proxy http://${localHost}:${localPort} https://ip.oxylabs.io/location`);
    console.log(`${'='.repeat(60)}\n`);
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