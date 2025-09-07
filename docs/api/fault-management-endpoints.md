# Fault Management & System Logs API Documentation

This document provides comprehensive API documentation for the fault management and system log endpoints.

## Fault Management Endpoints

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
- `force_refresh` (boolean, default: false) - Force refresh of cached data

**Response Example (No Faults):**
```json
{
  "faults": [],
  "summary": {
    "totalFaults": 0,
    "severityLevels": [],
    "faultClasses": [],
    "affectedResources": [],
    "severityBreakdown": {},
    "classBreakdown": {}
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
    "faultClasses": ["fault.fs.zfs.pool"],
    "affectedResources": ["zfs://pool=Array-0"],
    "severityBreakdown": {
      "Major": 1
    },
    "classBreakdown": {
      "fault.fs.zfs.pool": 1
    }
  },
  "raw_output": "--------------- ------------------------------------ -------------- ---------\nTIME            EVENT-ID                              MSG-ID         SEVERITY\n--------------- ------------------------------------ -------------- ---------\nJan 19 2025     c543b4ad-6cc7-40bc-891a-186100ef16a7  ZFS-8000-CS    Major\n",
  "cached": false,
  "last_updated": "2025-01-19T18:27:53.440Z",
  "cache_age_seconds": 0
}
```

### 2. GET /system/fault-management/faults/{uuid} - Get Specific Fault

**Request:**
```bash
GET /system/fault-management/faults/c543b4ad-6cc7-40bc-891a-186100ef16a7
Authorization: Bearer <api_key>
```

**Response Example:**
```json
{
  "fault": {
    "format": "detailed",
    "host": "hv-04.home.m4kr.net",
    "platform": "S5520HC",
    "faultClass": "fault.fs.zfs.pool",
    "affects": "zfs://pool=Array-0",
    "problemIn": "zfs://pool=Array-0",
    "description": "A ZFS pool failed to open.  Refer to http://illumos.org/msg/ZFS-8000-CS for more information.",
    "impact": "The pool data is unavailable",
    "action": "Run 'zpool status -x' and attach any missing devices, follow any provided recovery instructions or restore from backup."
  },
  "raw_output": "Host        : hv-04.home.m4kr.net\nPlatform    : S5520HC   Chassis_id  : ............\nProduct_sn  :\n\nFault class : fault.fs.zfs.pool\nAffects     : zfs://pool=Array-0\n                  faulted but still in service\nProblem in  : zfs://pool=Array-0\n                  faulted but still in service\n\nDescription : A ZFS pool failed to open.  Refer to\n              http://illumos.org/msg/ZFS-8000-CS for more information.\n\nResponse    : No automated response will occur.\n\nImpact      : The pool data is unavailable\n\nAction      : Run 'zpool status -x' and attach any missing devices, follow\n              any provided recovery instructions or restore from backup.",
  "uuid": "c543b4ad-6cc7-40bc-891a-186100ef16a7",
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

### 3. GET /system/fault-management/config - Get Fault Manager Configuration

**Request:**
```bash
GET /system/fault-management/config
Authorization: Bearer <api_key>
```

**Response Example:**
```json
{
  "config": [
    {
      "module": "cpumem-retire",
      "version": "1.0",
      "description": "CPU/Memory FRU Retire Agent"
    },
    {
      "module": "disk-retire",
      "version": "1.0",
      "description": "Disk FRU Retire Agent"
    },
    {
      "module": "zfs-retire",
      "version": "1.0",
      "description": "ZFS Retire Agent"
    }
  ],
  "raw_output": "MODULE                     VERSION\ncpumem-retire              1.0\ndisk-retire                1.0\nzfs-retire                 1.0",
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

### 4. POST /system/fault-management/actions/acquit - Acquit a Fault

**Request:**
```bash
POST /system/fault-management/actions/acquit
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "target": "c543b4ad-6cc7-40bc-891a-186100ef16a7"
}
```

**Response Example:**
```json
{
  "success": true,
  "message": "Successfully acquitted c543b4ad-6cc7-40bc-891a-186100ef16a7",
  "target": "c543b4ad-6cc7-40bc-891a-186100ef16a7",
  "uuid": null,
  "raw_output": "",
  "stderr": null,
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

### 5. POST /system/fault-management/actions/repaired - Mark Resource as Repaired

**Request:**
```bash
POST /system/fault-management/actions/repaired
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "fmri": "zfs://pool=Array-0"
}
```

**Response Example:**
```json
{
  "success": true,
  "message": "Successfully marked zfs://pool=Array-0 as repaired",
  "fmri": "zfs://pool=Array-0",
  "raw_output": "",
  "stderr": null,
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

### 6. POST /system/fault-management/actions/replaced - Mark Resource as Replaced

**Request:**
```bash
POST /system/fault-management/actions/replaced
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "fmri": "zfs://pool=Array-0"
}
```

**Response Example:**
```json
{
  "success": true,
  "message": "Successfully marked zfs://pool=Array-0 as replaced",
  "fmri": "zfs://pool=Array-0",
  "raw_output": "",
  "stderr": null,
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

## System Log Endpoints

### 1. GET /system/logs/list - List Available Log Files

**Request:**
```bash
GET /system/logs/list
Authorization: Bearer <api_key>
```

**Response Example:**
```json
{
  "log_files": [
    {
      "name": "messages",
      "path": "/var/adm/messages",
      "relativePath": "adm/messages",
      "size": 2048576,
      "modified": "2025-01-19T18:27:53.440Z",
      "sizeFormatted": "2.00 MB",
      "type": "system"
    },
    {
      "name": "authlog",
      "path": "/var/log/authlog",
      "relativePath": "log/authlog", 
      "size": 1024000,
      "modified": "2025-01-19T18:25:53.440Z",
      "sizeFormatted": "1000.00 KB",
      "type": "authentication"
    },
    {
      "name": "syslog",
      "path": "/var/log/syslog",
      "relativePath": "log/syslog",
      "size": 5242880,
      "modified": "2025-01-19T18:27:53.440Z", 
      "sizeFormatted": "5.00 MB",
      "type": "system"
    }
  ],
  "directories": [
    {
      "path": "/var/log",
      "fileCount": 15,
      "files": [...]
    },
    {
      "path": "/var/adm", 
      "fileCount": 8,
      "files": [...]
    }
  ],
  "total_files": 23,
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

### 2. GET /system/logs/{logname} - Read System Log File

**Request:**
```bash
GET /system/logs/syslog?lines=50&tail=true&grep=error
Authorization: Bearer <api_key>
```

**Query Parameters:**
- `lines` (integer, default: 100) - Number of lines to return
- `tail` (boolean, default: true) - Read from end of file vs beginning
- `grep` (string) - Filter lines containing this pattern  
- `since` (string) - Show entries since this timestamp

**Response Example:**
```json
{
  "logname": "syslog",
  "path": "/var/log/syslog",
  "lines": [
    "Jan 19 18:27:53 hv-04 kernel: error: disk timeout on c0t0d0",
    "Jan 19 18:25:12 hv-04 sshd[1234]: error: invalid user login attempt",
    "Jan 19 18:20:01 hv-04 cron[5678]: error: job failed to execute"
  ],
  "totalLines": 3,
  "requestedLines": 50,
  "tail": true,
  "filters": {
    "grep": "error",
    "since": null
  },
  "raw_output": "Jan 19 18:27:53 hv-04 kernel: error: disk timeout on c0t0d0\nJan 19 18:25:12 hv-04 sshd[1234]: error: invalid user login attempt\nJan 19 18:20:01 hv-04 cron[5678]: error: job failed to execute\n",
  "fileInfo": {
    "size": 5242880,
    "sizeFormatted": "5.00 MB",
    "modified": "2025-01-19T18:27:53.440Z"
  },
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

### 3. GET /system/logs/fault-manager/{type} - Read Fault Manager Logs

**Request:**
```bash
GET /system/logs/fault-manager/faults?since=01/19/25&verbose=false
Authorization: Bearer <api_key>
```

**Types:** `faults`, `errors`, `info`, `info-hival`

**Query Parameters:**
- `since` (string) - Show entries since this time
- `class` (string) - Filter by fault class pattern
- `uuid` (string) - Filter by specific UUID
- `verbose` (boolean, default: false) - Show verbose output

**Response Example:**
```json
{
  "logType": "faults", 
  "lines": [
    "TIME                 UUID                                 SUNW-MSG-ID",
    "Jan 19 18:27:53.391 c543b4ad-6cc7-40bc-891a-186100ef16a7 ZFS-8000-CS",
    "Jan 19 18:25:12.123 d1234567-89ab-cdef-1234-567890abcdef FMD-8000-11"
  ],
  "totalLines": 3,
  "filters": {
    "since": "01/19/25",
    "class": null,
    "uuid": null,
    "verbose": false
  },
  "command": "fmdump -t \"01/19/25\"",
  "raw_output": "TIME                 UUID                                 SUNW-MSG-ID\nJan 19 18:27:53.391 c543b4ad-6cc7-40bc-891a-186100ef16a7 ZFS-8000-CS\nJan 19 18:25:12.123 d1234567-89ab-cdef-1234-567890abcdef FMD-8000-11\n",
  "timestamp": "2025-01-19T18:27:53.440Z"
}
```

## Enhanced Health Endpoint

### GET /monitoring/health - Get System Health (Enhanced with Fault Status)

**Request:**
```bash
GET /monitoring/health
Authorization: Bearer <api_key>
```

**Response Example (Healthy System):**
```json
{
  "status": "healthy",
  "lastUpdate": "2025-01-19T18:27:53.440Z",
  "networkErrors": 0,
  "storageErrors": 0,
  "faultStatus": {
    "hasFaults": false,
    "faultCount": 0,
    "severityLevels": [],
    "lastCheck": "2025-01-19T18:27:53.440Z",
    "faults": [],
    "error": null
  },
  "recentActivity": {
    "network": true,
    "storage": true
  },
  "uptime": 1234567,
  "reboot_required": false,
  "reboot_info": null,
  "service": { ... }
}
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
        "severity": "Major",
        "format": "summary"
      }
    ],
    "error": null
  },
  "recentActivity": {
    "network": true,
    "storage": true
  },
  "uptime": 1234567,
  "reboot_required": false,
  "reboot_info": null,
  "service": { ... }
}
```

## Health Status Values

- **"healthy"** - No faults, service running normally
- **"degraded"** - Minor faults or warnings present
- **"faulted"** - Major faults present  
- **"critical"** - Critical faults present
- **"stopped"** - Monitoring service not running
- **"error"** - Health check failed

## Error Responses

**403 Service Disabled:**
```json
{
  "error": "Fault management is disabled in configuration"
}
```

**404 Not Found:**
```json
{
  "error": "Fault with UUID c543b4ad-6cc7-40bc-891a-186100ef16a7 not found"
}
```

**400 Bad Request:**
```json
{
  "error": "Target (FMRI or UUID) is required"
}
```

**400 File Security:**
```json
{
  "error": "File too large: 100.00 MB exceeds limit of 50MB"
}
```

**500 Internal Server Error:**
```json
{
  "error": "Failed to get system faults",
  "details": "Command failed: pfexec fmadm faulty"
}
```

## Implementation Notes

1. **Caching**: Fault data is cached for 1 hour (configurable) to improve performance
2. **Security**: Log files are restricted to configured paths with size limits
3. **Raw Output**: All responses include raw command output for debugging
4. **Health Integration**: Fault status automatically included in health endpoint
5. **Administrative Actions**: Acquit/repaired/replaced actions clear fault cache
6. **Error Handling**: Comprehensive error responses with details

## Configuration

The following configuration sections control these endpoints:

```yaml
fault_management:
  enabled: true
  cache_interval: 3600  # 1 hour
  timeout: 30
  max_faults_displayed: 50

system_logs:
  enabled: true
  max_lines: 1000
  default_tail_lines: 100
  timeout: 30
  allowed_paths:
    - "/var/log"
    - "/var/adm"
    - "/var/fm/fmd"
  security:
    max_file_size_mb: 50
    forbidden_patterns:
      - "*.pid"
      - "*.lock"
      - "*/private/*"
