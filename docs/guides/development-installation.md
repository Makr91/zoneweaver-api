---
title: Development Installation
layout: default
nav_order: 3
parent: Guides
permalink: /docs/guides/development-installation/
---

# Development Installation
{: .no_toc }

Complete guide for setting up ZoneWeaver API for development and testing.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## System Requirements

### OmniOS Development Environment
- **Operating System**: OmniOS (Latest stable release)
- **Node.js**: Version 16 or higher
- **Git**: For cloning the repository
- **Build Tools**: GNU Make for native module compilation
- **Memory**: 1GB+ RAM for development
- **Storage**: 2GB+ free space (includes dependencies and development tools)

### Development Tools
- **Code Editor**: VS Code, Vim, or your preferred editor
- **API Testing**: curl, Postman, or similar tools
- **Database Tools**: SQLite CLI (optional)

---

## Quick Development Setup

### 1. Install Prerequisites

```bash
# Install Node.js and development tools
pfexec pkg install ooce/runtime/node-22 developer/build/gnu-make developer/gcc-14

# Install Git if not already present
pfexec pkg install developer/versioning/git

# Install SQLite CLI (optional, for database inspection)
pfexec pkg install database/sqlite-3
```

### 2. Clone Repository

```bash
# Clone the repository
git clone https://github.com/Makr91/zoneweaver-api.git
cd zoneweaver-api

# Create development branch (optional)
git checkout -b feature/your-feature-name
```

### 3. Install Dependencies

```bash
# Install all dependencies (including development dependencies)
MAKE=gmake npm install

# Install nodemon globally for auto-restart during development
pfexec npm install -g nodemon
```

### 4. Setup Development Configuration

```bash
# Copy production configuration as starting point
cp packaging/config/production-config.yaml config/config.dev.yaml

# Edit development configuration
vi config/config.dev.yaml
```

Example development configuration:
```yaml
server:
  http_port: 5000
  https_port: 5001

ssl:
  key_path: "./ssl/dev-server.key"
  cert_path: "./ssl/dev-server.crt"

database:
  dialect: "sqlite"
  storage: "./dev-database.sqlite"
  logging: true  # Enable SQL query logging in development

api_keys:
  bootstrap_enabled: true
  bootstrap_auto_disable: false  # Keep bootstrap enabled for testing
  key_length: 64
  hash_rounds: 10  # Lower hash rounds for faster development

cors:
  whitelist:
    - "http://localhost:3000"   # ZoneWeaver frontend dev server
    - "https://localhost:3001"  # ZoneWeaver frontend dev HTTPS
    - "http://localhost:8080"   # Alternative dev server
    - "*"  # Allow all origins in development (NOT for production!)

stats:
  public_access: true  # Allow public access to stats in development
```

### 5. Generate Development SSL Certificates

```bash
# Create SSL directory
mkdir -p ssl

# Generate self-signed development certificates
openssl req -x509 -newkey rsa:2048 -keyout ssl/dev-server.key -out ssl/dev-server.crt -days 365 -nodes -subj "/C=US/ST=Development/L=Development/O=ZoneWeaver/CN=localhost"

# Set proper permissions
chmod 600 ssl/dev-server.key
chmod 644 ssl/dev-server.crt
```

---

## Development Workflow

### Start Development Server

```bash
# Start with auto-restart (recommended for development)
npm run dev

# Or start normally
npm start

# Start with custom config
NODE_ENV=development CONFIG_PATH=./config/config.dev.yaml npm start
```

Expected output:
```
🚀 ZoneWeaver API Server starting...
📊 Database connection established (SQLite: ./dev-database.sqlite)
🔐 API Key system initialized
🌐 HTTP Server listening on port 5000
🔒 HTTPS Server listening on port 5001
📚 Swagger documentation available at /api-docs
✅ ZoneWeaver API Server ready!
```

### Development Commands

```bash
# Start development server with auto-restart
npm run dev

# Run tests (when available)
npm test

# Generate API documentation
npm run docs

# Lint code
npm run lint

# Format code
npm run format
```

### Bootstrap API Key for Development

```bash
# Generate development API key
curl -X POST http://localhost:5000/api-keys/bootstrap \
     -H "Content-Type: application/json" \
     -d '{"name": "Development-Key"}'

# Save the returned API key for testing
export ZONEWEAVER_API_KEY="wh_your_dev_api_key_here"
```

---

## Development Configuration

### Environment Variables

Create a `.env` file in the project root for development-specific settings:

```bash
# .env file
NODE_ENV=development
CONFIG_PATH=./config/config.dev.yaml
DEBUG=zoneweaver:*
PORT=5000
HTTPS_PORT=5001
```

### Package.json Scripts

The project includes several npm scripts for development:

```json
{
  "scripts": {
    "start": "node index.js",
    "dev": "nodemon index.js",
    "docs": "node scripts/generate-docs.js",
    "test": "jest",
    "lint": "eslint .",
    "format": "prettier --write ."
  }
}
```

### Database Development

#### SQLite Database Location
Development database: `./dev-database.sqlite`

#### Database Operations
```bash
# View database contents
sqlite3 dev-database.sqlite ".tables"

# Inspect API keys table
sqlite3 dev-database.sqlite "SELECT name, created_at FROM api_keys;"

# Reset development database (removes all data!)
rm dev-database.sqlite
npm run dev  # Will recreate database on startup
```

---

## API Development

### Testing API Endpoints

```bash
# Test API key authentication
curl -H "Authorization: Bearer $ZONEWEAVER_API_KEY" \
     http://localhost:5000/api/entities

# Test system stats
curl http://localhost:5000/stats

# Test API documentation
curl http://localhost:5000/api-docs/openapi.json
```

### Interactive API Documentation

Access the Swagger UI at:
- **HTTP**: http://localhost:5000/api-docs
- **HTTPS**: https://localhost:5001/api-docs (accept self-signed certificate)

### Development API Features

Development mode includes:
- **Bootstrap endpoint** remains enabled
- **CORS** allows all origins (`*`)
- **SQL logging** enabled for debugging
- **Detailed error messages** in responses
- **Hot reload** with nodemon

---

## Code Development

### Project Structure

```
zoneweaver-api/
├── controllers/          # API endpoint logic
├── models/              # Database models
├── routes/              # Route definitions
├── middleware/          # Custom middleware (API key auth, etc.)
├── lib/                 # Utility libraries
├── config/              # Configuration files
├── docs/                # Documentation source
├── packaging/           # OmniOS package files
└── scripts/             # Build and utility scripts
```

### Adding New API Endpoints

1. **Create Controller**: Add business logic in `controllers/`
2. **Define Model**: Add database model in `models/` (if needed)
3. **Add Route**: Wire up endpoint in `routes/index.js`
4. **Add Documentation**: Update OpenAPI spec in `config/swagger.js`
5. **Test**: Use curl or Swagger UI to test

### Example: Adding a New Endpoint

```javascript
// controllers/ExampleController.js
class ExampleController {
    static async getExample(req, res) {
        try {
            res.json({ message: 'Hello from ZoneWeaver API!' });
        } catch (error) {
            res.status(500).json({ msg: error.message });
        }
    }
}

// routes/index.js (add route)
router.get('/example', ExampleController.getExample);
```

---

## Testing and Debugging

### Debug Logging

Enable debug logging with environment variables:

```bash
# Enable all debug logs
DEBUG=zoneweaver:* npm run dev

# Enable specific component logs
DEBUG=zoneweaver:auth npm run dev
DEBUG=zoneweaver:database npm run dev
```

### Manual Testing

```bash
# Test different HTTP methods
curl -X GET -H "Authorization: Bearer $ZONEWEAVER_API_KEY" http://localhost:5000/api/entities
curl -X POST -H "Authorization: Bearer $ZONEWEAVER_API_KEY" -H "Content-Type: application/json" -d '{}' http://localhost:5000/api/entities

# Test error handling
curl http://localhost:5000/api/entities  # Should return 401 without API key
```

### Database Debugging

```bash
# View all tables
sqlite3 dev-database.sqlite ".schema"

# Monitor database changes
sqlite3 dev-database.sqlite ".log stdout" ".timer on"
```

---

## Development Tips

### Hot Reload Setup
Nodemon is configured to watch for changes in:
- `.js` files
- `.json` files  
- `config/*.yaml` files

### Git Workflow
```bash
# Create feature branch
git checkout -b feature/your-feature

# Make changes and commit
git add .
git commit -m "Add new feature"

# Push and create pull request
git push origin feature/your-feature
```

### Code Style
- Use **ESLint** for code linting
- Use **Prettier** for code formatting
- Follow **Node.js best practices**
- Add **JSDoc comments** for functions

### Performance Testing

```bash
# Load testing with Apache Bench (if available)
ab -n 100 -c 10 -H "Authorization: Bearer $ZONEWEAVER_API_KEY" http://localhost:5000/api/entities

# Memory usage monitoring
node --inspect index.js  # Chrome DevTools debugging
```

---

## Troubleshooting

### Common Development Issues

#### Port Already in Use
```bash
# Find process using port 5000
lsof -i :5000
# Kill process
kill -9 <PID>
```

#### Database Locked
```bash
# Remove database lock (stops all processes first)
pkill -f "node.*index.js"
rm dev-database.sqlite-wal dev-database.sqlite-shm
```

#### SSL Certificate Issues
```bash
# Regenerate development certificates
rm ssl/dev-server.*
openssl req -x509 -newkey rsa:2048 -keyout ssl/dev-server.key -out ssl/dev-server.crt -days 365 -nodes -subj "/C=US/ST=Development/L=Development/O=ZoneWeaver/CN=localhost"
```

#### Node.js Module Issues
```bash
# Clear npm cache and reinstall
rm -rf node_modules package-lock.json
npm cache clean --force
MAKE=gmake npm install
```

### Getting Help

- **GitHub Issues**: [Report bugs and request features](https://github.com/Makr91/zoneweaver-api/issues)
- **Documentation**: Review other guides in the `/docs/guides/` directory
- **API Reference**: Use the interactive Swagger documentation at `/api-docs`

---

## Contributing

### Before Submitting Pull Requests

1. **Test your changes** locally
2. **Update documentation** if needed
3. **Add appropriate tests** (when test framework is available)
4. **Follow code style** guidelines
5. **Update CHANGELOG.md** if making significant changes

### Code Review Checklist

- [ ] Code follows project style guidelines
- [ ] All API endpoints are properly documented
- [ ] Changes don't break existing functionality
- [ ] Security considerations have been addressed
- [ ] Performance impact has been considered

See the [Code of Conduct](../../CODE_OF_CONDUCT.md) for community guidelines.
