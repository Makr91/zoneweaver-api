# Complete API Documentation for Frontend Implementation

This document provides comprehensive API documentation for **Fault Management**, **System Logs**, and **Real-time Log Streaming** endpoints.

## Fault Management API Endpoints

### 1. GET /system/fault-management/faults - List System Faults

**Request:**
```bash
GET /system/fault-management/faults?all=false&summary=false&limit=50&force_refresh=false
Authorization: Bearer <api_key>
```

**Query Parameters:**
- `all` (boolean, default: false) - Include all faults including resolved ones
- `summary` (boolean, default: false) - Return one-line summary format
- `limit` (integer, default: 50) - Maximum number of faults to return
- `force_refresh` (boolean, default: false) - Force refresh of cached data (normally cached 1 hour)

**Response Example (No Faults):**
```json
{
  "faults": [],
  "summary": {
    "totalFaults": 0,
    "severityLevels": [],
    "faultClasses": [],
    "affectedResources": []
  },
  "raw_output": "",
  "cached": true,
  "last_updated": "2025-01-19T18:27:53.440Z",
  "cache_age_seconds": 1234
}
```

**Response Example (With Faults):**
```json
{
  "faults": [
    {
      "time": "Jan 19 2025",
      "uuid": "c543b4ad-6cc7-40bc-891a-186100ef16a7",
      "msgId": "ZFS-8000-CS",
      "severity": "Major",
      "format": "summary"
    }
  ],
  "summary": {
    "totalFaults": 1,
    "severityLevels": ["Major"],
    "severityBreakdown": { "Major": 1 },
    "faultClasses": ["fault.fs.zfs.pool"],
    "affectedResources": ["zfs://pool=Array-0"]
  },
  "cached": false,
  "last_updated": "2025-01-19T18:27:53.440Z"
}
```

### 2. POST /system/fault-management/actions/acquit - Acquit a Fault

**Request:**
```bash
POST /system/fault-management/actions/acquit
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "target": "c543b4ad-6cc7-40bc-891a-186100ef16a7"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Successfully acquitted c543b4ad-6cc7-40bc-891a-186100ef16a7",
  "target": "c543b4ad-6cc7-40bc-891a-186100ef16a7",
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

### 3. Enhanced Health Endpoint - GET /monitoring/health

**Request:**
```bash
GET /monitoring/health
Authorization: Bearer <api_key>
```

**Response Example (System with Faults):**
```json
{
  "status": "faulted",
  "lastUpdate": "2025-01-19T18:27:53.440Z",
  "networkErrors": 0,
  "storageErrors": 0,
  "faultStatus": {
    "hasFaults": true,
    "faultCount": 1,
    "severityLevels": ["Major"],
    "lastCheck": "2025-01-19T18:27:53.440Z",
    "faults": [
      {
        "time": "Jan 19 2025",
        "uuid": "c543b4ad-6cc7-40bc-891a-186100ef16a7",
        "msgId": "ZFS-8000-CS",
        "severity": "Major"
      }
    ]
  },
  "uptime": 1234567,
  "reboot_required": false
}
```

**Health Status Values:**
- `"healthy"` - No faults, service running
- `"degraded"` - Minor faults present
- `"faulted"` - Major faults present
- `"critical"` - Critical faults present

## System Log Endpoints

### 1. GET /system/logs/list - List Available Log Files

**Request:**
```bash
GET /system/logs/list
Authorization: Bearer <api_key>
```

**Response:**
```json
{
  "log_files": [
    {
      "name": "messages",
      "path": "/var/adm/messages",
      "size": 2048576,
      "sizeFormatted": "2.00 MB",
      "type": "system",
      "modified": "2025-01-19T18:27:53.440Z"
    },
    {
      "name": "authlog", 
      "path": "/var/log/authlog",
      "size": 1024000,
      "sizeFormatted": "1000.00 KB",
      "type": "authentication",
      "modified": "2025-01-19T18:25:53.440Z"
    }
  ],
  "total_files": 23,
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

### 2. GET /system/logs/{logname} - Read Log File

**Request:**
```bash
GET /system/logs/syslog?lines=50&tail=true&grep=error
Authorization: Bearer <api_key>
```

**Response:**
```json
{
  "logname": "syslog",
  "path": "/var/log/syslog",
  "lines": [
    "Jan 19 18:27:53 hv-04 kernel: error: disk timeout on c0t0d0",
    "Jan 19 18:25:12 hv-04 sshd[1234]: error: invalid user login"
  ],
  "totalLines": 2,
  "requestedLines": 50,
  "tail": true,
  "filters": {
    "grep": "error",
    "since": null
  },
  "fileInfo": {
    "size": 5242880,
    "sizeFormatted": "5.00 MB"
  },
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

## Real-time Log Streaming (WebSocket)

### 3. POST /system/logs/{logname}/stream/start - Start Log Stream

**Request:**
```bash
POST /system/logs/syslog/stream/start
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "follow_lines": 50,
  "grep_pattern": "error"
}
```

**Response:**
```json
{
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "websocket_url": "/logs/stream/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "logname": "syslog",
  "log_path": "/var/log/syslog",
  "follow_lines": 50,
  "grep_pattern": "error",
  "status": "created",
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

### 4. WebSocket Connection for Log Streaming

**WebSocket URL:**
```
ws://localhost:5000/logs/stream/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

**WebSocket Message Types (Received from Server):**

**Status Message:**
```json
{
  "type": "status",
  "message": "Connected to syslog", 
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

**Log Line (Real-time):**
```json
{
  "type": "log_line",
  "line": "Jan 19 18:28:15 hv-04 kernel: new error detected",
  "timestamp": "2025-01-19T18:28:15.123Z"
}
```

**Error Message:**
```json
{
  "type": "error",
  "message": "tail: /var/log/syslog: file truncated",
  "timestamp": "2025-01-19T18:28:15.123Z"
}
```

**WebSocket Commands (Send to Server):**

**Ping/Pong:**
```json
{"type": "ping"}
// Server responds: {"type": "pong", "timestamp": "..."}
```

**Pause Streaming:**
```json
{"type": "pause"}
```

**Resume Streaming:**
```json
{"type": "resume"}
```

### 5. DELETE /system/logs/stream/{sessionId}/stop - Stop Log Stream

**Request:**
```bash
DELETE /system/logs/stream/a1b2c3d4-e5f6-7890-abcd-ef1234567890/stop
Authorization: Bearer <api_key>
```

**Response:**
```json
{
  "success": true,
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "message": "Log stream session stopped successfully",
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

### 6. GET /system/logs/stream/sessions - List Active Stream Sessions

**Request:**
```bash
GET /system/logs/stream/sessions
Authorization: Bearer <api_key>
```

**Response:**
```json
{
  "sessions": [
    {
      "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "logname": "syslog",
      "status": "active",
      "created_at": "2025-01-19T18:27:53.440Z"
    }
  ],
  "active_sessions": [
    {
      "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "logname": "syslog", 
      "connected_at": "2025-01-19T18:27:53.440Z",
      "lines_sent": 156,
      "client_ip": "127.0.0.1"
    }
  ],
  "total_active": 1,
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

## Frontend Implementation Guide

### React WebSocket Log Streaming Example:

```javascript
// 1. Start log stream
const startLogStream = async (logname, grepPattern = null) => {
  const response = await fetch('/system/logs/' + logname + '/stream/start', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      follow_lines: 50,
      grep_pattern: grepPattern
    })
  });
  
  const data = await response.json();
  return data.session_id;
};

// 2. Connect to WebSocket
const connectToLogStream = (sessionId, onMessage) => {
  const ws = new WebSocket(`ws://localhost:5000/logs/stream/${sessionId}`);
  
  ws.onopen = () => {
    console.log('Connected to log stream');
  };
  
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    
    switch(message.type) {
      case 'status':
        console.log('Status:', message.message);
        break;
      case 'log_line':
        onMessage(message.line, message.timestamp);
        break;
      case 'error':
        console.error('Log error:', message.message);
        break;
    }
  };
  
  ws.onclose = () => {
    console.log('Log stream disconnected');
  };
  
  return ws;
};

// 3. Usage example
const sessionId = await startLogStream('syslog', 'error');
const ws = connectToLogStream(sessionId, (line, timestamp) => {
  // Add line to UI
  setLogLines(prev => [...prev, { line, timestamp }]);
});

// 4. Cleanup
const stopStream = async (sessionId) => {
  await fetch(`/system/logs/stream/${sessionId}/stop`, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + apiKey }
  });
};
```

### Frontend Log Viewer Features:

✅ **Real-time Updates** - New log lines appear instantly  
✅ **Pattern Filtering** - Filter by keyword/regex during streaming  
✅ **Pause/Resume** - Control stream flow  
✅ **Multiple Streams** - Monitor multiple log files simultaneously  
✅ **Auto-cleanup** - Sessions auto-expire after 1 hour  
✅ **Connection Management** - Automatic reconnection handling  

### Error Handling:

**503 Service Disabled:**
```json
{
  "error": "System logs are disabled in configuration"
}
```

**404 Log Not Found:**
```json
{
  "error": "Log file 'nonexistent.log' not found in allowed directories"
}
```

**429 Too Many Streams:**
```json
{
  "error": "Maximum concurrent log streams reached"
}
```

## Configuration Settings

These features are controlled by configuration:

```yaml
fault_management:
  enabled: true
  cache_interval: 3600  # 1 hour fault cache
  timeout: 30

system_logs:
  enabled: true
  max_lines: 1000
  max_concurrent_streams: 10
  stream_session_timeout: 3600
  allowed_paths:
    - "/var/log"
    - "/var/adm" 
    - "/var/fm/fmd"
  security:
    max_file_size_mb: 50
```

## Key Features Summary:

### **Fault Management:**
- ✅ Real-time fault monitoring via `fmadm faulty`
- ✅ 1-hour caching for performance (configurable)
- ✅ Integrated into health endpoint status
- ✅ Administrative actions (acquit, repair, replace)

### **System Logs:**
- ✅ Browse available log files
- ✅ Read log files with filtering (grep, tail, head)
- ✅ Security path validation and size limits

### **Log Streaming:**
- ✅ Real-time `tail -f` via WebSocket
- ✅ Multiple concurrent streams per user
- ✅ Live filtering and control commands
- ✅ Automatic session cleanup

This provides comprehensive system monitoring and log analysis capabilities for the Zoneweaver frontend!
