---
title: Zone Management
layout: default
nav_order: 5
parent: Guides
permalink: /docs/guides/zone-management/
---

# Zone Management
{: .no_toc }

Create, modify, and manage bhyve virtual machine zones through the API.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

The ZoneweaverAPI provides full zone lifecycle management:

- **Create** zones with `POST /zones` - from scratch, from templates, or with existing storage
- **Modify** zone configuration with `PUT /zones/:zoneName` - changes queue and apply on next boot
- **Start/Stop/Restart** zones with existing lifecycle endpoints
- **Delete** zones with `DELETE /zones/:zoneName`

All create and modify operations are **asynchronous** - they return a task ID immediately, and the actual work is processed in the background via the task queue. Track progress with `GET /tasks/:taskId`.

---

## Creating Zones

### Minimal Creation

Only `name` and `brand` are required:

```bash
curl -X POST https://your-server:5001/zones \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-vm-01",
    "brand": "bhyve"
  }'
```

Response:

```json
{
  "success": true,
  "task_id": "a1b2c3d4-...",
  "zone_name": "test-vm-01",
  "operation": "zone_create",
  "status": "pending",
  "message": "Zone creation task queued successfully"
}
```

This creates a bare bhyve zone with default settings and no disks - useful for PXE/netboot scenarios or when you plan to add resources via modification later.

### Creation with Resources

Specify optional resources at creation time:

```bash
curl -X POST https://your-server:5001/zones \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "web-server-01",
    "brand": "bhyve",
    "ram": "2G",
    "vcpus": "2",
    "diskif": "virtio",
    "netif": "virtio",
    "vnc": "on",
    "boot_volume": {
      "create_new": true,
      "pool": "rpool",
      "dataset": "zones",
      "volume_name": "root",
      "size": "30G",
      "sparse": true
    },
    "nics": [
      {
        "physical": "vnic0",
        "global_nic": "igb0"
      }
    ],
    "cdroms": [
      { "path": "/iso/omnios-r151050.iso" }
    ],
    "start_after_create": true
  }'
```

### Creation from Template

Clone an existing template for fast provisioning:

```bash
curl -X POST https://your-server:5001/zones \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "from-template",
    "brand": "bhyve",
    "source": {
      "type": "template",
      "template_dataset": "rpool/templates/omnios-base",
      "clone_strategy": "clone"
    },
    "boot_volume": {
      "pool": "rpool",
      "dataset": "zones",
      "volume_name": "root",
      "size": "30G"
    }
  }'
```

Clone strategies:
- `clone` - Thin ZFS clone (instant, shares blocks with template)
- `copy` - Full ZFS send/recv (independent copy, slower)

### Creation with Existing Storage

Attach an existing ZFS volume as the boot disk:

```bash
curl -X POST https://your-server:5001/zones \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "migrated-vm",
    "brand": "bhyve",
    "ram": "4G",
    "vcpus": "4",
    "boot_volume": {
      "create_new": false,
      "existing_dataset": "rpool/vms/old-server/root"
    }
  }'
```

{: .note }
The API checks if existing zvols are already in use by another zone. Use `"force": true` to override this check.

### Auto-Start After Creation

Set `start_after_create: true` to automatically boot the zone once creation completes:

```bash
curl -X POST https://your-server:5001/zones \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "auto-start-vm",
    "brand": "bhyve",
    "ram": "2G",
    "start_after_create": true
  }'
```

The response includes both task IDs:

```json
{
  "success": true,
  "task_id": "create-task-uuid",
  "start_task_id": "start-task-uuid",
  "zone_name": "auto-start-vm",
  "operation": "zone_create",
  "status": "pending",
  "message": "Zone creation task queued with auto-start"
}
```

### Cloud-Init Provisioning

Configure cloud-init attributes for automated guest setup:

```bash
curl -X POST https://your-server:5001/zones \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "cloud-vm",
    "brand": "bhyve",
    "ram": "2G",
    "vcpus": "2",
    "boot_volume": {
      "create_new": true,
      "pool": "rpool",
      "dataset": "zones",
      "volume_name": "root",
      "size": "30G"
    },
    "cloud_init": {
      "enabled": "on",
      "dns_domain": "example.com",
      "password": "changeme",
      "resolvers": "8.8.8.8,8.8.4.4",
      "sshkey": "ssh-rsa AAAA..."
    }
  }'
```

---

## Modifying Zones

### Overview

Zone modifications are applied via `zonecfg` and **take effect on next zone boot**. The zone can continue running while changes are queued - this allows you to make multiple modifications before restarting.

### Changing Resources

Update RAM, vCPUs, or other attributes:

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "ram": "4G",
    "vcpus": "4",
    "vnc": "on"
  }'
```

Response:

```json
{
  "success": true,
  "task_id": "modify-task-uuid",
  "zone_name": "web-server-01",
  "operation": "zone_modify",
  "status": "pending",
  "message": "Modification queued. Changes will take effect on next zone boot.",
  "requires_restart": true
}
```

### Adding and Removing NICs

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "add_nics": [
      { "physical": "vnic1", "global_nic": "igb0" }
    ],
    "remove_nics": ["vnic0"]
  }'
```

NICs with `global_nic` are created on-demand when the zone boots. Omit `global_nic` for pre-created VNICs.

### Adding and Removing Disks

Add a new disk:

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "add_disks": [
      {
        "create_new": true,
        "pool": "rpool",
        "dataset": "zones",
        "volume_name": "data",
        "size": "100G"
      }
    ]
  }'
```

Attach an existing zvol:

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "add_disks": [
      {
        "create_new": false,
        "existing_dataset": "rpool/shared/backup-vol"
      }
    ]
  }'
```

Remove a disk:

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "remove_disks": ["disk0"]
  }'
```

### Adding and Removing CD-ROMs

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "add_cdroms": [
      { "path": "/iso/install.iso" }
    ]
  }'
```

### Updating Cloud-Init

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "cloud_init": {
      "enabled": "on",
      "dns_domain": "newdomain.com",
      "resolvers": "1.1.1.1,1.0.0.1"
    }
  }'
```

### Setting Autoboot

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "autoboot": true
  }'
```

---

## Tracking Progress

All creation and modification operations are asynchronous. Track progress via the task API:

```bash
curl https://your-server:5001/tasks/TASK_ID \
  -H "Authorization: Bearer wh_your_api_key"
```

Creation tasks report granular progress:

| Progress | Stage |
|----------|-------|
| 5% | Validating parameters |
| 10% | Preparing storage (ZFS volumes) |
| 30% | Importing template (if applicable) |
| 40% | Applying zone configuration |
| 50% | Configuring boot disk |
| 60% | Configuring additional disks |
| 70% | Configuring CD-ROMs |
| 75% | Configuring network interfaces |
| 80% | Configuring cloud-init |
| 90% | Installing zone |
| 95% | Creating database record |
| 100% | Complete |

---

## Error Handling

### Duplicate Zone (409)

```json
{
  "error": "Zone web-server-01 already exists in database"
}
```

### Invalid Zone Name (400)

```json
{
  "error": "Invalid zone name"
}
```

### No Changes Specified (400)

```json
{
  "error": "No modification fields specified"
}
```

### Zvol In Use (during task execution)

If a zvol is already attached to another zone, the creation/modification task will fail unless `force: true` is set in the request body.

### Rollback on Failure

If zone creation fails at any stage, the system automatically rolls back:
1. Removes the `zonecfg` configuration (if applied)
2. Destroys any ZFS datasets that were created during the task (does not touch existing datasets)

---

## Available Properties

### Zone Attributes

| Property | Type | Description | Example |
|----------|------|-------------|---------|
| `name` | string | Zone name (required) | `"web-server-01"` |
| `brand` | string | Zone brand (required for creation) | `"bhyve"` |
| `ram` | string | Memory allocation | `"2G"` |
| `vcpus` | string | Virtual CPU count | `"2"` |
| `bootrom` | string | Boot ROM firmware | `"BHYVE_RELEASE_CSM"` |
| `hostbridge` | string | Host bridge emulation | `"i440fx"` |
| `diskif` | string | Disk interface | `"virtio"` |
| `netif` | string | Network interface type | `"virtio"` |
| `os_type` | string | Guest OS type | `"generic"` |
| `vnc` | string | VNC console | `"on"` |
| `acpi` | string | ACPI support | `"on"` |
| `xhci` | string | xHCI USB controller | `"on"` |
| `autoboot` | boolean | Auto-boot on host startup | `false` |

### Boot Volume Options

| Option | Description |
|--------|-------------|
| `create_new: true` | Create a new ZFS volume with specified pool/dataset/size |
| `existing_dataset` | Attach an existing ZFS dataset (zvol) |
| From template | Clone or copy from a template dataset |
| Omitted | No boot disk (diskless zone for PXE/netboot) |
