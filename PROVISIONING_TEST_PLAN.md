# Zoneweaver API - Provisioning Test Plan

## Environment Setup
```bash
export API_KEY="wh_s2kk8KS8LLZUopOgqNSyklAg_4YWcONaoujq476HHnTDEkaOwHJ4OfOggAB5IOdwYc_qZh6aMEXIO-1rO3J8eA"
export BASE_URL="https://hv-04-backend.home.m4kr.net:5001"
```

## Pre-requisites

### 1. Check Available Templates
```bash
pfexec zfs list -t all -r rpool/templates
```
Expected: `rpool/templates/STARTcloud/debian13-server/2025.8.22@ready`

### 2. Check Provisioning Artifacts
```bash
curl -s "$BASE_URL/artifacts?type=provisioning" -H "Authorization: Bearer $API_KEY" | jq '.artifacts[] | {id, name, path}'
```
Expected: HCL Domino artifact with ID `8dbb755a-5d7d-4eee-bff5-dad570419b4b`

### 3. Check Recipes
```bash
curl -s "$BASE_URL/provisioning/recipes" -H "Authorization: Bearer $API_KEY" | jq '.recipes[] | select(.name == "debian-netplan") | {id, name}'
```
Expected: debian-netplan recipe with ID `43fea354-74f5-45da-a3b4-72ce100ee358`

## Zone Creation & Provisioning Workflow

### Step 1: Create Zone
```bash
curl -X POST "$BASE_URL/zones" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-debian13",
    "brand": "bhyve",
    "ram": "2G",
    "vcpus": "2",
    "vm_type": "production",
    "source": {
      "type": "template",
      "template_dataset": "rpool/templates/STARTcloud/debian13-server/2025.8.22",
      "clone_strategy": "clone"
    },
    "boot_volume": {
      "create_new": false,
      "sparse": true
    },
    "vnc": "on",
    "nics": [
      {"global_nic": "estub_vz_1", "nic_type": "internal"},
      {"global_nic": "ixgbe1", "vlan_id": "11", "nic_type": "external"}
    ]
  }'
```

**Note**: Zone will be created with auto-generated partition_id (e.g., `0001--test-debian13`)

### Step 2: Set Provisioning Configuration
**Note**: MAC address is auto-detected from the first NIC during provisioning - no need to specify it manually!


```bash
curl -X PUT "$BASE_URL/zones/0001--test-debian13" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "provisioning": {
      "artifact_id": "8dbb755a-5d7d-4eee-bff5-dad570419b4b",
      "recipe_id": "43fea354-74f5-45da-a3b4-72ce100ee358",
      "ip": "10.190.190.10",
      "credentials": {
        "username": "startcloud",
        "password": "STARTcloud24@!",
        "ssh_key_path": "hcl_domino_standalone_provisioner/hcl_domino_standalone_provisioner/core/ssh_keys/id_rsa"
      },
      "variables": {
        "boot_string": "Booted - STARTcloud",
        "mac": "02:08:20:75:e9:9a",
        "ip": "10.190.190.10",
        "prefix": "24",
        "gateway": "10.190.190.1",
        "dns": "8.8.8.8"
      },
      "provisioners": []
    }
  }'
```

**Important**: Replace `"mac"` value with the actual MAC from Step 2!

### Step 4: Start Provisioning Pipeline
```bash
curl -X POST "$BASE_URL/zones/0001--test-debian13/provision" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

This orchestrates the full pipeline:
1. **zone_provisioning_extract** - Extract artifact to provisioning dataset
2. **start** - Boot the zone
3. **zone_setup** - Configure network via zlogin recipe
4. **zone_wait_ssh** - Wait for SSH to become available
5. **zone_sync** - Sync provisioning files to /vagrant
6. **zone_provision** - Execute provisioners

### Step 5: Monitor Progress
```bash
# Watch task status
curl -s "$BASE_URL/tasks?zone_name=0001--test-debian13&limit=15" -H "Authorization: Bearer $API_KEY" | jq '.tasks[] | {operation, status, error_message}'

# Or use watch for live updates
watch -n 2 "curl -s '$BASE_URL/tasks?zone_name=0001--test-debian13&limit=15' -H 'Authorization: Bearer \$API_KEY' | jq '.tasks[] | {operation, status, error_message}'"
```

## Troubleshooting

### If zone_setup Fails (Network Configuration)
Check zlogin console output:
```bash
pfexec zlogin -C 0001--test-debian13
```
Press `~.` to exit.

Check recipe steps:
```bash
curl -s "$BASE_URL/provisioning/recipes/43fea354-74f5-45da-a3b4-72ce100ee358" -H "Authorization: Bearer $API_KEY" | jq '.recipe.steps'
```

### If zone_wait_ssh Fails
Verify permissions (should be automatic after code fixes):
```bash
# Check zonepath permissions (should be 755)
pfexec ls -ld /rpool/zones/0001--test-debian13

# Check provisioning dataset ownership (should be zoneapi:other)
pfexec ls -ld /rpool/zones/0001--test-debian13/provisioning

# Check SSH key permissions (should be 600, owned by zoneapi)
pfexec ls -la /rpool/zones/0001--test-debian13/provisioning/hcl_domino_standalone_provisioner/hcl_domino_standalone_provisioner/core/ssh_keys/id_rsa
```

Manual SSH test as zoneapi user:
```bash
pfexec su - zoneapi -c "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null startcloud@10.190.190.10 -i /rpool/zones/0001--test-debian13/provisioning/hcl_domino_standalone_provisioner/hcl_domino_standalone_provisioner/core/ssh_keys/id_rsa 'echo ready'"
```

If manual fix needed (temporary, until code fixes work):
```bash
pfexec chmod 755 /rpool/zones/0001--test-debian13
pfexec chown -R zoneapi:other /rpool/zones/0001--test-debian13/provisioning
pfexec chmod 600 /rpool/zones/0001--test-debian13/provisioning/hcl_domino_standalone_provisioner/hcl_domino_standalone_provisioner/core/ssh_keys/id_rsa
```

### Check Network Connectivity
```bash
ping 10.190.190.10
```

Connect to zone and verify interface:
```bash
pfexec zlogin 0001--test-debian13
ip addr show vnice3_0001_0
exit
```

## Cleanup

### Delete Zone
```bash
curl -X DELETE "$BASE_URL/zones/0001--test-debian13?force=true&cleanup_datasets=true" -H "Authorization: Bearer $API_KEY"
```

### Verify Cleanup
```bash
pfexec zoneadm list -icv
pfexec zfs list | grep test-debian13
```

## Expected Results

After successful provisioning:
- ✅ Zone created with partition_id prefix (0001--test-debian13)
- ✅ Artifact extracted to `/rpool/zones/0001--test-debian13/provisioning/`
- ✅ Zone boots and reaches login prompt
- ✅ Network configured via zlogin (interface renamed to vnice3_0001_0, IP 10.190.190.10)
- ✅ SSH accessible with key from artifact
- ✅ Provisioning files synced to /vagrant inside zone
- ✅ Provisioners execute successfully

## Code Changes Made

### ZoneCreationManager.js (lines 707-712)
After zone installation, set zonepath to 755:
```javascript
await executeCommand(`pfexec chmod 755 ${zonepath}`);
```

### ZoneProvisionManager.js (lines 548-554)
After artifact extraction, fix ownership and permissions:
```javascript
await executeCommand(`pfexec chown -R zoneapi:other ${dataset_path}`);
await executeCommand(`pfexec find ${dataset_path} -type f \\( -name 'id_rsa' -o -name 'id_dsa' -o -name 'id_ecdsa' -o -name 'id_ed25519' \\) -exec chmod 600 {} +`);
```

## Notes

- Service user: `zoneapi` (uid=301, gid=301)
- Provisioning network: estub_vz_1 (10.190.190.0/24)
- External network: ixgbe1 VLAN 11
- VNIC naming: `vnic{nictype}{vmtype}_{partition_id}_{nic_index}`
  - Example: `vnice3_0001_0` (external, production, partition 0001, nic 0)
