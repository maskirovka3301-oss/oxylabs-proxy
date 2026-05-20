// Test direct connection to Oxylabs with correct authentication
import tls from 'tls';

const config = {
    host: 'dc.oxylabs.io',
    port: 8000,
    username: 'drazulay_QOmHH',
    password: '1B98_ajs8HYMfJi',
    country: 'US'
};

const proxyUsername = `user-${config.username}-country-${config.country}`;
const auth = Buffer.from(`${proxyUsername}:${config.password}`).toString('base64');

console.log('Testing Oxylabs connection...');
console.log(`Username format: ${proxyUsername}`);

const socket = tls.connect({
    host: config.host,
    port: config.port,
    rejectUnauthorized: false
}, () => {
    console.log('TLS Connected, sending CONNECT request...');
    
    const connectReq = [
        `CONNECT ip.oxylabs.io:443 HTTP/1.1`,
        `Host: ip.oxylabs.io:443`,
        `Proxy-Authorization: Basic ${auth}`,
        `Proxy-Connection: keep-alive`,
        '', ''
    ].join('\r\n');
    
    socket.write(connectReq);
});

let buffer = '';
socket.on('data', (data) => {
    buffer += data.toString();
    if (buffer.includes('\r\n\r\n')) {
        console.log('Response headers:', buffer.split('\r\n')[0]);
        if (buffer.includes('200 Connection established')) {
            console.log('✅ Authentication successful!');
            
            // Send a test HTTP request
            const httpReq = [
                `GET /location HTTP/1.1`,
                `Host: ip.oxylabs.io`,
                `Connection: close`,
                '', ''
            ].join('\r\n');
            socket.write(httpReq);
        } else {
            console.log('❌ Authentication failed');
            console.log(buffer);
            socket.end();
        }
    }
});

socket.on('error', (err) => {
    console.error('Connection error:', err.message);
});

setTimeout(() => {
    console.log('Test complete');
    socket.end();
    process.exit(0);
}, 5000);