# Comprehensive Testing Guide - Zone Creation & Provisioning System

# 1. Check status (Should be enabled but not ready)

curl -s $BASE_URL/provisioning/network/status \
  -H "Authorization: Bearer $API_KEY" | jq

# 2. Run Setup (Should return task_ids immediately)

curl -s -X POST $BASE_URL/provisioning/network/setup \
  -H "Authorization: Bearer $API_KEY" | jq

# 3. Wait a few seconds for tasks to complete

sleep 5

# 4. Verify Status again (Should be ready: true)

curl -s $BASE_URL/provisioning/network/status \
  -H "Authorization: Bearer $API_KEY" | jq

# 5. Teardown (Should return task_ids)

curl -s -X DELETE $BASE_URL/provisioning/network/teardown \
  -H "Authorization: Bearer $API_KEY" | jq


This guide provides curl commands to test **ALL** endpoints related to the zone creation and provisioning implementation.

## API Configuration

```bash
# API Key (use for all requests)
API_KEY="wh_s2kk8KS8LLZUopOgqNSyklAg_4YWcONaoujq476HHnTDEkaOwHJ4OfOggAB5IOdwYc_qZh6aMEXIO-1rO3J8eA"
BASE_URL="https://hv-04-backend.home.m4kr.net:5001"

# Use this header in all requests
AUTH_HEADER="-H \"Authorization: Bearer $API_KEY\""
```

---

## 1. Zone Management Endpoints (Phase 1)

### 1.1 List All Zones
```bash
curl -s $BASE_URL/zones \
  -H "Authorization: Bearer $API_KEY"
```

### 1.2 Create Zone (Minimal - Name + Brand Only)
```bash
curl -s -X POST $BASE_URL/zones \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "name": "test-minimal",
    "brand": "bhyve"
  }'
```

### 1.3 Create Zone (Full Configuration)
```bash
curl -s -X POST $BASE_URL/zones \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "name": "test-full",
    "brand": "bhyve",
    "ram": "2G",
    "vcpus": "2",
    "bootrom": "BHYVE_RELEASE_CSM",
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
    "cloud_init": {
      "enabled": "on",
      "dns_domain": "example.com",
      "password": "changeme",
      "resolvers": "8.8.8.8,8.8.4.4"
    }
  }'
```

### 1.4 Create Zone with Existing Zvol
```bash
curl -s -X POST $BASE_URL/zones \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "name": "test-existing-zvol",
    "brand": "bhyve",
    "ram": "4G",
    "vcpus": "4",
    "boot_volume": {
      "create_new": false,
      "existing_dataset": "rpool/zones/disk"
    }
  }'
```

### 1.5 Create Zone with Auto-Start
```bash
curl -s -X POST $BASE_URL/zones \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "name": "test-autostart",
    "brand": "bhyve",
    "ram": "2G",
    "vcpus": "2",
    "boot_volume": {
      "create_new": true,
      "pool": "rpool",
      "dataset": "zones",
      "volume_name": "root",
      "size": "10G"
    },
    "start_after_create": true
  }'
```

### 1.6 Get Zone Details
```bash
curl -s $BASE_URL/zones/test-full \
  -H "Authorization: Bearer $API_KEY"
```

### 1.7 Get Zone Configuration
```bash
curl -s $BASE_URL/zones/test-full/config \
  -H "Authorization: Bearer $API_KEY"
```

### 1.8 Modify Zone (Change Resources)
```bash
curl -s -X PUT $BASE_URL/zones/test-full \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "ram": "4G",
    "vcpus": "4",
    "vnc": "on"
  }'
```

### 1.9 Modify Zone (Add NIC)
```bash
curl -s -X PUT $BASE_URL/zones/test-full \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "add_nics": [
      {
        "physical": "vnic1",
        "global_nic": "igb0"
      }
    ]
  }'
```

### 1.10 Modify Zone (Add Disk)
```bash
curl -s -X PUT $BASE_URL/zones/test-full \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "add_disks": [
      {
        "create_new": true,
        "pool": "rpool",
        "dataset": "zones",
        "volume_name": "data",
        "size": "50G"
      }
    ]
  }'
```

### 1.11 Modify Zone (Add CDROM)
```bash
curl -s -X PUT $BASE_URL/zones/test-full \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "add_cdroms": [
      {"path": "/Array-0/ISOs/virtio-win-0.1.190.iso"}
    ]
  }'
```

### 1.12 Modify Zone (Set Autoboot)
```bash
curl -s -X PUT $BASE_URL/zones/test-full \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "autoboot": true
  }'
```

### 1.13 Modify Zone (Update Cloud-Init)
```bash
curl -s -X PUT $BASE_URL/zones/test-full \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "cloud_init": {
      "enabled": "on",
      "dns_domain": "newdomain.com",
      "password": "newpassword"
    }
  }'
```

### 1.14 Start Zone
```bash
curl -s -X POST $BASE_URL/zones/test-full/start \
  -H "Authorization: Bearer $API_KEY"
```

### 1.15 Stop Zone
```bash
curl -s -X POST $BASE_URL/zones/test-full/stop \
  -H "Authorization: Bearer $API_KEY"
```

### 1.16 Restart Zone
```bash
curl -s -X POST $BASE_URL/zones/test-full/restart \
  -H "Authorization: Bearer $API_KEY"
```

### 1.17 Delete Zone (Without Cleanup)
```bash
curl -s -X DELETE $BASE_URL/zones/test-minimal \
  -H "Authorization: Bearer $API_KEY"
```

### 1.18 Delete Zone (With ZFS Dataset Cleanup)
```bash
curl -s -X DELETE "$BASE_URL/zones/test-full?cleanup_datasets=true" \
  -H "Authorization: Bearer $API_KEY"
```

### 1.19 Test Error: Create Zone with Missing Brand
```bash
# Should return 400 Bad Request
curl -s -X POST $BASE_URL/zones \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "name": "test-no-brand"
  }'
```

### 1.20 Test Error: Create Duplicate Zone
```bash
# First create a zone
curl -s -X POST $BASE_URL/zones \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"name":"test-dup","brand":"bhyve"}'

# Try to create again - should return 409 Conflict
curl -s -X POST $BASE_URL/zones \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"name":"test-dup","brand":"bhyve"}'
```

### 1.21 Test Error: Modify Nonexistent Zone
```bash
# Should return 404 Not Found
curl -s -X PUT $BASE_URL/zones/nonexistent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"ram":"2G"}'
```

---

## 2. Zone Orchestration Endpoints

### 2.1 Get Orchestration Status
```bash
curl -s $BASE_URL/zones/orchestration/status \
  -H "Authorization: Bearer $API_KEY"
```

### 2.2 Enable Orchestration
```bash
curl -s -X POST $BASE_URL/zones/orchestration/enable \
  -H "Authorization: Bearer $API_KEY"
```

### 2.3 Disable Orchestration
```bash
curl -s -X POST $BASE_URL/zones/orchestration/disable \
  -H "Authorization: Bearer $API_KEY"
```

### 2.4 List Zone Priorities
```bash
curl -s $BASE_URL/zones/priorities \
  -H "Authorization: Bearer $API_KEY"
```

### 2.5 Test Orchestration (Dry Run)
```bash
curl -s -X POST $BASE_URL/zones/orchestration/test \
  -H "Authorization: Bearer $API_KEY"
```

---

## 3. Task Queue Endpoints

### 3.1 List All Tasks
```bash
curl -s $BASE_URL/tasks \
  -H "Authorization: Bearer $API_KEY"
```

### 3.2 List Tasks with Filters
```bash
# Filter by status
curl -s "$BASE_URL/tasks?status=running" \
  -H "Authorization: Bearer $API_KEY"

# Filter by operation
curl -s "$BASE_URL/tasks?operation=zone_create" \
  -H "Authorization: Bearer $API_KEY"

# Pagination
curl -s "$BASE_URL/tasks?limit=10&offset=0" \
  -H "Authorization: Bearer $API_KEY"
```

### 3.3 Get Task Details
```bash
curl -s $BASE_URL/tasks/{task_id} \
  -H "Authorization: Bearer $API_KEY"
```

### 3.4 Get Task Statistics
```bash
curl -s $BASE_URL/tasks/stats \
  -H "Authorization: Bearer $API_KEY"
```

### 3.5 Cancel Task
```bash
curl -s -X DELETE $BASE_URL/tasks/{task_id} \
  -H "Authorization: Bearer $API_KEY"
```

---

## 4. NAT & IP Forwarding Endpoints (Phase 2)

### 4.1 Get NAT Rules
```bash
curl -s $BASE_URL/network/nat/rules \
  -H "Authorization: Bearer $API_KEY"
```

### 4.2 Create NAT Rule
```bash
curl -s -X POST $BASE_URL/network/nat/rules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "bridge": "igb0",
    "subnet": "10.190.190.0/24",
    "target": "0/32",
    "protocol": "tcp/udp",
    "type": "portmap"
  }'
```

### 4.3 Delete NAT Rule
```bash
curl -s -X DELETE $BASE_URL/network/nat/rules/{ruleId} \
  -H "Authorization: Bearer $API_KEY"
```

### 4.4 Get NAT/ipfilter Status
```bash
curl -s $BASE_URL/network/nat/status \
  -H "Authorization: Bearer $API_KEY"
```

### 4.5 Get IP Forwarding Status
```bash
curl -s $BASE_URL/network/forwarding \
  -H "Authorization: Bearer $API_KEY"
```

### 4.6 Enable IP Forwarding
```bash
curl -s -X PUT $BASE_URL/network/forwarding \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "interfaces": ["igb0", "provision_interconnect0"],
    "enabled": true
  }'
```

### 4.7 Disable IP Forwarding
```bash
curl -s -X PUT $BASE_URL/network/forwarding \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "interfaces": ["igb0", "provision_interconnect0"],
    "enabled": false
  }'
```

---

## 5. DHCP Server Endpoints (Phase 2)

### 5.1 Get DHCP Configuration
```bash
curl -s $BASE_URL/network/dhcp/config \
  -H "Authorization: Bearer $API_KEY"
```

### 5.2 Update DHCP Configuration
```bash
curl -s -X PUT $BASE_URL/network/dhcp/config \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "subnet": "10.190.190.0",
    "netmask": "255.255.255.0",
    "router": "10.190.190.1",
    "range_start": "10.190.190.10",
    "range_end": "10.190.190.254",
    "listen_interface": "provision_interconnect0"
  }'
```

### 5.3 List DHCP Static Hosts
```bash
curl -s $BASE_URL/network/dhcp/hosts \
  -H "Authorization: Bearer $API_KEY"
```

### 5.4 Add DHCP Host Entry
```bash
curl -s -X POST $BASE_URL/network/dhcp/hosts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "hostname": "test-zone",
    "mac": "aa:bb:cc:dd:ee:ff",
    "ip": "10.190.190.10"
  }'
```

### 5.5 Remove DHCP Host Entry
```bash
curl -s -X DELETE $BASE_URL/network/dhcp/hosts/test-zone \
  -H "Authorization: Bearer $API_KEY"
```

### 5.6 Get DHCP Service Status
```bash
curl -s $BASE_URL/network/dhcp/status \
  -H "Authorization: Bearer $API_KEY"
```

### 5.7 Control DHCP Service (Start)
```bash
curl -s -X PUT $BASE_URL/network/dhcp/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "action": "start"
  }'
```

### 5.8 Control DHCP Service (Stop)
```bash
curl -s -X PUT $BASE_URL/network/dhcp/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "action": "stop"
  }'
```

### 5.9 Control DHCP Service (Refresh)
```bash
curl -s -X PUT $BASE_URL/network/dhcp/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "action": "refresh"
  }'
```

---

## 6. Provisioning Network Endpoints (Phase 2)

### 6.1 Get Provisioning Network Status
```bash
curl -s $BASE_URL/provisioning/network/status \
  -H "Authorization: Bearer $API_KEY"
```

### 6.2 Setup Provisioning Network (Idempotent)
```bash
curl -s -X POST $BASE_URL/provisioning/network/setup \
  -H "Authorization: Bearer $API_KEY"
```

### 6.3 Verify Setup Completed
```bash
# Check status again after setup
curl -s $BASE_URL/provisioning/network/status \
  -H "Authorization: Bearer $API_KEY"
```

### 6.4 Teardown Provisioning Network
```bash
curl -s -X DELETE $BASE_URL/provisioning/network/teardown \
  -H "Authorization: Bearer $API_KEY"
```

---

## 7. Provisioning Tool Status

### 7.1 Get Provisioning Tool Installation Status
```bash
curl -s $BASE_URL/provisioning/status \
  -H "Authorization: Bearer $API_KEY"
```

---

## 8. Recipe Management Endpoints (Phase 2)

### 8.1 List All Recipes (Verify Seeded Defaults)
```bash
# Should return 5 default recipes:
# 1. debian-netplan
# 2. linux-ifconfig
# 3. omnios-dladm
# 4. windows-sac
# 5. cloud-init-wait
curl -s $BASE_URL/provisioning/recipes \
  -H "Authorization: Bearer $API_KEY"
```

### 8.2 Get Specific Recipe
```bash
curl -s $BASE_URL/provisioning/recipes/{recipe_id} \
  -H "Authorization: Bearer $API_KEY"
```

### 8.3 Create Custom Recipe
```bash
curl -s -X POST $BASE_URL/provisioning/recipes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "name": "custom-debian",
    "description": "Custom Debian network setup",
    "os_family": "linux",
    "brand": "bhyve",
    "boot_string": "Web console:",
    "login_prompt": "login:",
    "shell_prompt": ":~$",
    "timeout_seconds": 300,
    "steps": [
      {
        "type": "wait",
        "pattern": "{{login_prompt}}",
        "timeout": 60
      },
      {
        "type": "send",
        "value": "{{username}}\r\n"
      },
      {
        "type": "wait",
        "pattern": "Password:"
      },
      {
        "type": "send",
        "value": "{{password}}\r\n"
      },
      {
        "type": "wait",
        "pattern": "{{shell_prompt}}"
      },
      {
        "type": "command",
        "value": "echo \"Network configured\""
      }
    ],
    "variables": {
      "username": "root",
      "password": "changeme"
    }
  }'
```

### 8.4 Update Recipe
```bash
curl -s -X PUT $BASE_URL/provisioning/recipes/{recipe_id} \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "timeout_seconds": 600,
    "description": "Updated description"
  }'
```

### 8.5 Test Recipe (Dry Run Against Zone)
```bash
curl -s -X POST $BASE_URL/provisioning/recipes/{recipe_id}/test \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "zone_name": "test-zone",
    "variables": {
      "username": "root",
      "password": "changeme",
      "vnic_name": "vnic0",
      "ip": "10.190.190.10",
      "prefix": "24",
      "gateway": "10.190.190.1",
      "dns": "8.8.8.8"
    }
  }'
```

### 8.6 Delete Recipe
```bash
curl -s -X DELETE $BASE_URL/provisioning/recipes/{recipe_id} \
  -H "Authorization: Bearer $API_KEY"
```

---

## 9. Provisioning Profile Endpoints (Phase 2)

### 9.1 List All Profiles
```bash
curl -s $BASE_URL/provisioning/profiles \
  -H "Authorization: Bearer $API_KEY"
```

### 9.2 Create Provisioning Profile
```bash
curl -s -X POST $BASE_URL/provisioning/profiles \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "name": "debian-ansible",
    "description": "Debian with Ansible provisioning",
    "recipe_id": "<debian-netplan-recipe-id>",
    "default_credentials": {
      "username": "startcloud",
      "password": "STARTcloud24@!"
    },
    "default_provisioners": [
      {
        "type": "ansible_local",
        "playbook": "/vagrant/ansible/playbook.yml",
        "collections": ["startcloud.startcloud_roles"]
      }
    ],
    "default_variables": {
      "domain": "example.com"
    }
  }'
```

### 9.3 Get Profile Details
```bash
curl -s $BASE_URL/provisioning/profiles/{profile_id} \
  -H "Authorization: Bearer $API_KEY"
```

### 9.4 Update Profile
```bash
curl -s -X PUT $BASE_URL/provisioning/profiles/{profile_id} \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "description": "Updated profile description",
    "default_variables": {
      "domain": "newdomain.com"
    }
  }'
```

### 9.5 Delete Profile
```bash
curl -s -X DELETE $BASE_URL/provisioning/profiles/{profile_id} \
  -H "Authorization: Bearer $API_KEY"
```

---

## 10. Artifact Management Endpoints
AI NEEDS TO GIVE ME COMMAND TO CREAT DUMMY ARTIFACT FOR PROVISIONING TESTS, THEN TEST LISTING AND GETTING ARTIFACT DETAILS. ALSO NEED TO TEST ERROR CASES LIKE UPLOADING WITHOUT PREPARE OR WITH INVALID TASK ID.
### 10.1 Prepare Artifact Upload
```bash
curl -s -X POST $BASE_URL/artifacts/upload/prepare \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "filename": "provisioning.tar.gz",
    "size": 1048576,
    "zone_name": "test-zone",
    "artifact_type": "provisioning"
  }'
```

### 10.2 Upload Artifact Chunks
```bash
# Get task_id from prepare response, then upload file
curl -s -X POST $BASE_URL/artifacts/upload/{task_id} \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@/path/to/provisioning.tar.gz"
```

### 10.3 List Artifacts
```bash
curl -s $BASE_URL/artifacts \
  -H "Authorization: Bearer $API_KEY"
```

### 10.4 Get Artifact Details
```bash
curl -s $BASE_URL/artifacts/{artifact_id} \
  -H "Authorization: Bearer $API_KEY"
```

---

## 11. Zone Provisioning Orchestration (Phase 2 - Full Pipeline)

### 11.1 Full Provisioning Workflow

#### Step 1: Create Zone
```bash
ZONE_NAME="prov-test-$(date +%s)"

curl -s -X POST $BASE_URL/zones \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "{
    \"name\": \"$ZONE_NAME\",
    \"brand\": \"bhyve\",
    \"ram\": \"2G\",
    \"vcpus\": \"2\",
    \"boot_volume\": {
      \"create_new\": true,
      \"pool\": \"rpool\",
      \"dataset\": \"zones\",
      \"volume_name\": \"root\",
      \"size\": \"30G\"
    },
    \"nics\": [
      {
        \"physical\": \"vnic0\",
        \"global_nic\": \"igb0\"
      }
    ]
  }"
```

#### Step 2: Upload Provisioning Artifact
```bash
# Prepare upload
PREP_RESPONSE=$(curl -s -X POST $BASE_URL/artifacts/upload/prepare \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "{
    \"filename\": \"provisioning.tar.gz\",
    \"size\": 1048576,
    \"zone_name\": \"$ZONE_NAME\",
    \"artifact_type\": \"provisioning\"
  }")

# Extract task_id
TASK_ID=$(echo $PREP_RESPONSE | jq -r '.task_id')

# Upload file
curl -s -X POST $BASE_URL/artifacts/upload/$TASK_ID \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@/path/to/provisioning.tar.gz"

# Get artifact_id from task metadata
ARTIFACT_ID=$(curl -s $BASE_URL/tasks/$TASK_ID \
  -H "Authorization: Bearer $API_KEY" | jq -r '.metadata.artifact_id')
```

#### Step 3: Get Recipe ID
```bash
# List recipes and get debian-netplan recipe ID
RECIPE_ID=$(curl -s $BASE_URL/provisioning/recipes \
  -H "Authorization: Bearer $API_KEY" | \
  jq -r '.recipes[] | select(.name=="debian-netplan") | .id')
```

#### Step 4: Set Provisioning Configuration
```bash
curl -s -X PUT $BASE_URL/zones/$ZONE_NAME \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "{
    \"provisioning\": {
      \"recipe_id\": \"$RECIPE_ID\",
      \"mode\": \"ansible_local\",
      \"artifact_id\": \"$ARTIFACT_ID\",
      \"credentials\": {
        \"username\": \"startcloud\",
        \"password\": \"STARTcloud24@!\"
      },
      \"provisioners\": [
        {
          \"type\": \"ansible_local\",
          \"playbook\": \"/vagrant/ansible/playbook.yml\",
          \"collections\": [\"startcloud.startcloud_roles\"],
          \"extra_vars\": {
            \"hostname\": \"$ZONE_NAME\",
            \"domain\": \"example.com\"
          }
        }
      ]
    }
  }"
```

#### Step 5: Kick Off Provisioning Pipeline
```bash
curl -s -X POST $BASE_URL/zones/$ZONE_NAME/provision \
  -H "Authorization: Bearer $API_KEY"
```

#### Step 6: Monitor Provisioning Status
```bash
# Poll status
watch -n 5 "curl -s $BASE_URL/zones/$ZONE_NAME/provision/status \
  -H \"Authorization: Bearer $API_KEY\" | jq"
```

#### Step 7: (If Needed) Cancel Provisioning
```bash
curl -s -X POST $BASE_URL/zones/$ZONE_NAME/provision/cancel \
  -H "Authorization: Bearer $API_KEY"
```

#### Step 8: (If Needed) Rollback to Pre-Provision Snapshot
```bash
curl -s -X POST $BASE_URL/zones/$ZONE_NAME/provision/rollback \
  -H "Authorization: Bearer $API_KEY"
```

#### Step 9: Cleanup - Delete Zone with Datasets
```bash
curl -s -X DELETE "$BASE_URL/zones/$ZONE_NAME?cleanup_datasets=true" \
  -H "Authorization: Bearer $API_KEY"
```

### 11.2 Get Provisioning Status
```bash
curl -s $BASE_URL/zones/{zone_name}/provision/status \
  -H "Authorization: Bearer $API_KEY"
```

---

## 12. Verification Checklist

### Phase 1 - Zone Management
- [ ] List zones
- [ ] Create minimal zone (name + brand)
- [ ] Create full zone (all options)
- [ ] Create zone with existing zvol
- [ ] Create zone with auto-start
- [ ] Get zone details
- [ ] Get zone config
- [ ] Modify RAM/vCPUs
- [ ] Add NIC to zone
- [ ] Add disk to zone
- [ ] Add CDROM to zone
- [ ] Set autoboot
- [ ] Update cloud-init
- [ ] Start zone
- [ ] Stop zone
- [ ] Restart zone
- [ ] Delete zone without cleanup
- [ ] Delete zone with cleanup_datasets=true (verify ZFS datasets removed)
- [ ] Error: missing brand → 400
- [ ] Error: duplicate name → 409
- [ ] Error: modify nonexistent → 404

### Phase 2 - NAT & Forwarding
- [ ] Get NAT rules
- [ ] Create NAT rule
- [ ] Delete NAT rule
- [ ] Get ipfilter status
- [ ] Get forwarding status
- [ ] Enable forwarding
- [ ] Disable forwarding

### Phase 2 - DHCP
- [ ] Get DHCP config
- [ ] Update DHCP config
- [ ] List DHCP hosts
- [ ] Add DHCP host
- [ ] Remove DHCP host
- [ ] Get DHCP status
- [ ] Start DHCP service
- [ ] Stop DHCP service
- [ ] Refresh DHCP service

### Phase 2 - Provisioning Network
- [ ] Get provisioning network status
- [ ] Setup provisioning network
- [ ] Verify all components created (etherstub, VNIC, IP, NAT, DHCP)
- [ ] Teardown provisioning network

### Phase 2 - Recipes
- [ ] List recipes (verify 5 seeded defaults)
- [ ] Get specific recipe
- [ ] Create custom recipe
- [ ] Update recipe
- [ ] Test recipe against zone
- [ ] Delete recipe

### Phase 2 - Provisioning Profiles
- [ ] List profiles
- [ ] Create profile
- [ ] Get profile details
- [ ] Update profile
- [ ] Delete profile

### Phase 2 - Full Provisioning Pipeline
- [ ] Create zone
- [ ] Upload provisioning artifact
- [ ] Set provisioning config
- [ ] Kick off provisioning
- [ ] Monitor status
- [ ] Verify provisioning ZFS dataset created
- [ ] Verify @pre-provision snapshot exists
- [ ] (Test rollback if provisioning fails)
- [ ] Verify @post-provision snapshot after success
- [ ] Delete zone with cleanup

### Task Queue
- [ ] List tasks
- [ ] Filter tasks by status
- [ ] Filter tasks by operation
- [ ] Get task details
- [ ] Get task statistics
- [ ] Cancel running task

### Zone Orchestration
- [ ] Get orchestration status
- [ ] Enable orchestration
- [ ] Disable orchestration
- [ ] List zone priorities
- [ ] Test orchestration (dry run)

---

## Notes

1. **Task Tracking**: Most zone operations return a `task_id`. Use `GET /tasks/{task_id}` to monitor progress.

2. **ZFS Dataset Cleanup**: The `cleanup_datasets=true` query parameter is critical for testing. After deletion with this flag:
   - Verify: `pfexec zfs list -r rpool/zones/{zone_name}` should return "dataset does not exist"

3. **Recipe Seeding**: On first API startup, 5 default recipes are automatically seeded. Verify by calling `GET /provisioning/recipes`.

4. **Provisioning Network**: Setup is idempotent - safe to call multiple times. Teardown removes all components.

5. **NAT Rules**: After creating NAT rules, verify in host system: `pfexec cat /etc/ipf/ipnat.conf`

6. **DHCP Hosts**: After adding hosts, verify in host system: `pfexec cat /etc/dhcpd.conf`

7. **Artifact Upload**: Prepare returns a `task_id`. Upload to `/artifacts/upload/{task_id}`. Once complete, get `artifact_id` from task metadata.

8. **Provisioning Pipeline**: Creates task chain with dependencies:
   - extract → boot → setup → wait_ssh → sync → provision

9. **Snapshots**: Provisioning creates ZFS snapshots:
   - `@pre-provision`: Before provisioners run (rollback point)
   - `@post-provision`: After success (known-good state)

10. **Error Responses**: All errors return JSON: `{"msg": "Error description"}`
