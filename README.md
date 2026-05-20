# Local Oxylabs Proxy - SOCKS5/HTTP Forwarding Proxy

![Proxy](logo.jpg)

## Description

A lightweight, zero-dependency local proxy server that forwards traffic through Oxylabs residential proxies. Supports both SOCKS5 and HTTP protocols, designed specifically for headless browser automation and web scraping applications.

### Features

- **Dual Protocol Support**: SOCKS5 and HTTP proxy modes
- **Zero External Dependencies**: Pure Node.js implementation
- **JSON Configuration**: Easy setup without code modification
- **Headless Browser Ready**: Works seamlessly with Puppeteer, Playwright, and Selenium
- **Optional Authentication**: Built-in username/password support for local clients
- **Country Rotation**: Configurable Oxylabs country parameter
- **Bidirectional Tunneling**: Full support for HTTPS and all TCP-based protocols

### Usage

```
usage: node socks5-proxy.js

Starts a SOCKS5 proxy server on localhost:1080
Forwards all traffic through Oxylabs proxy

Configuration: Edit config.json with your Oxylabs credentials
```

### Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/local-oxylabs-proxy.git
cd local-oxylabs-proxy

# Edit configuration with your Oxylabs credentials
nano config.json

# Start the proxy server
npm start

# In another terminal, test with curl
curl --socks5 127.0.0.1:1080 https://ip.oxylabs.io/location
```

### Configuration Example

```json
{
    "oxylabs": {
        "host": "pr.oxylabs.io",
        "port": 7777,
        "username": "customer-USERNAME",
        "password": "PASSWORD",
        "country": "US"
    },
    "local": {
        "host": "127.0.0.1",
        "port": 1080
    },
    "auth": {
        "enabled": false,
        "username": "localuser",
        "password": "localpass"
    }
}
```

## How It Works

### SOCKS5 Protocol Implementation

The proxy implements the SOCKS5 protocol (RFC 1928) from scratch, handling the complete handshake sequence:

1. **Authentication Negotiation**: The server reads the client's supported authentication methods and responds with the chosen method (none or username/password).

2. **Request Processing**: After authentication, the client sends a CONNECT request containing the target hostname/IP and port number.

3. **Oxylabs Handshake**: The server establishes a connection to Oxylabs and performs a second SOCKS5 handshake, including username/password authentication with the country parameter.

4. **Bidirectional Tunneling**: Once both connections are established, data flows freely in both directions until either endpoint closes the connection.

### HTTP Proxy Mode

The HTTP proxy implementation handles both standard HTTP requests and CONNECT tunnels for HTTPS:

- **HTTP Requests**: Directly forwards standard HTTP requests with proper header manipulation
- **CONNECT Tunnels**: Establishes raw TCP tunnels for HTTPS and other SSL/TLS traffic
- **Header Injection**: Automatically adds Oxylabs authentication headers to all requests

### Browser Integration

When configured with headless browsers, the proxy intercepts all network traffic:

```javascript
// Puppeteer example
const browser = await puppeteer.launch({
    args: ['--proxy-server=socks5://127.0.0.1:1080']
});
```

All browser requests, including page loads, API calls, and WebSocket connections, are automatically routed through Oxylabs.

## Use Cases

### Web Scraping & Data Collection

- **Geotargeted Content Access**: Access region-restricted content by configuring the country parameter
- **IP Rotation**: Leverage Oxylabs' large IP pool to avoid rate limiting
- **Anonymous Browsing**: Mask your origin IP address during automated data collection

### Browser Automation

- **Puppeteer/Playwright Testing**: Test how websites appear from different geographic locations
- **SEO Monitoring**: Check search engine results pages from various countries
- **Ad Verification**: Validate ad placements and pricing across different markets

### Research & Analysis

- **Market Research**: Collect pricing data, product availability, and local content
- **Competitive Intelligence**: Monitor competitor websites without revealing your location
- **Academic Research**: Gather geographically-distributed data for studies

## Protocol Support

| Protocol | SOCKS5 Mode | HTTP Mode |
|----------|-------------|-----------|
| HTTP     | ✓           | ✓         |
| HTTPS    | ✓           | ✓         |
| WebSocket| ✓           | ✓         |
| FTP      | ✓           | ✗         |
| TCP      | ✓           | ✗ (CONNECT only) |

## Technical Details

### SOCKS5 Implementation

- **No External Dependencies**: Uses only Node.js `net` module
- **Full RFC Compliance**: Implements SOCKS5 as specified in RFC 1928
- **IPv4/IPv6 Support**: Handles both address types
- **Domain Name Resolution**: Supports domain names up to 255 characters
- **Bidirectional Piping**: Efficient data forwarding using stream pipes

### HTTP Proxy Implementation

- **CONNECT Method**: Full support for HTTPS tunneling
- **Header Preservation**: Maintains original headers while adding proxy authentication
- **Connection Pooling**: Reuses connections when possible for better performance

### Performance Characteristics

- **Low Overhead**: Minimal CPU usage, typically <1% for modest traffic
- **Memory Efficient**: Streams data without buffering entire requests
- **Concurrent Connections**: Handles multiple simultaneous connections
- **No Request Size Limits**: Can proxy arbitrarily large requests/responses

## Testing

### Test with cURL

```bash
# SOCKS5
curl --socks5 127.0.0.1:1080 https://httpbin.org/ip

# HTTP
curl --proxy http://127.0.0.1:8080 https://httpbin.org/ip
```

### Test with Node.js

```javascript
import { SocksProxyAgent } from 'socks-proxy-agent';

const agent = new SocksProxyAgent('socks5://127.0.0.1:1080');
const response = await fetch('https://api.ipify.org?format=json', { agent });
console.log(await response.json());
```

### Test with Python

```python
import socks
import socket
import requests

socks.set_default_proxy(socks.SOCKS5, "127.0.0.1", 1080)
socket.socket = socks.socksocket

response = requests.get('https://httpbin.org/ip')
print(response.json())
```

## Troubleshooting

### Common Issues

**Connection Refused**
- Verify the proxy server is running: `netstat -an | grep 1080`
- Check firewall settings: `sudo ufw status`

**Authentication Failed**
- Confirm Oxylabs credentials in config.json
- Verify country format: `customer-USERNAME-cc-US`

**Slow Performance**
- Reduce concurrent connections
- Check network latency to Oxylabs: `ping pr.oxylabs.io`
- Consider using a server closer to Oxylabs endpoints

**Browser Not Using Proxy**
- Verify proxy arguments in browser launch options
- Check browser documentation for correct syntax
- Test with curl first to isolate the issue

### Debug Mode

Enable verbose logging by running with environment variable:

```bash
DEBUG=socks5* node socks5-proxy.js
```

## Project Structure

```
local-oxylabs-proxy/
├── socks5-proxy.js      # SOCKS5 proxy server
├── http-proxy.js        # HTTP proxy server
├── config.json          # Configuration file
├── package.json         # Project metadata
└── README.md           # This file
```

## Requirements

- Node.js 14.x or higher
- Oxylabs proxy account
- Network access to pr.oxylabs.io:7777

## Installation

```bash
# Clone repository
git clone https://github.com/yourusername/local-oxylabs-proxy.git
cd local-oxylabs-proxy

# Install (no dependencies required for SOCKS5 version)
npm install  # Only needed for HTTP proxy version

# Configure
cp config.example.json config.json
nano config.json

# Start server
npm start
```

## Limitations

- SOCKS5 UDP ASSOCIATE command not implemented
- GSS-API authentication not supported
- IPv6 address parsing simplified (full support planned)
- Maximum 1024 concurrent connections (configurable)

## Future Improvements

- [ ] UDP ASSOCIATE support for DNS over SOCKS5
- [ ] Connection pooling and reuse
- [ ] Automatic country rotation strategies
- [ ] Bandwidth limiting and traffic shaping
- [ ] Request/response logging with rotation
- [ ] Docker container for easy deployment
- [ ] Prometheus metrics endpoint
- [ ] Configuration hot-reload

## License

MIT License - See LICENSE file for details.

## Contact

For issues, questions, or contributions:

**Email**: maskirovka3301@gmail.com

---

**If this tool helps your web scraping or automation projects, please give the repository a star.**

*Route everything through Oxylabs with zero dependencies.*
