# Vagrant-Zones & HCL Domino Provisioner - Complete Analysis

## Executive Summary

This document explains how vagrant-zones integrates with the HCL Domino Standalone Provisioner to automate zone creation, boot detection, network configuration, and provisioning on OmniOS bhyve zones.

## 1. Architecture Overview

### Component Stack
```
Vagrantfile (entry point)
    ↓
Hosts.rb (configuration processor)
    ↓
Hosts.yml (zone & provisioning config)
    ↓
vagrant-zones Provider Plugin
    ↓
OmniOS (zonecfg/zoneadm/dladm/zlogin)
```

### Key Design Principles
- **On-demand VNIC creation**: VNICs created during zone boot with auto-generated MACs
- **Serial console automation**: Uses `zlogin -C` for boot detection and early network setup
- **Multi-stage provisioning**: Boot → Network Setup → SSH → Ansible
- **ZFS-based storage**: All zones on ZFS datasets with snapshot support

---

## 2. Configuration Files

### Vagrantfile (Entry Point)
```ruby
require 'yaml'
require File.expand_path("#{File.dirname(__FILE__)}/core/Hosts.rb")

settings = YAML::load(File.read("#{File.dirname(__FILE__)}/Hosts.yml"))

Vagrant.configure("2") do |config|
  Hosts.configure(config, settings)
end
```

**Purpose**: Minimal wrapper that loads Hosts.yml and delegates to Hosts.rb

### Hosts.yml Structure

```yaml
hosts:
  - settings:
      # Identity
      hostname: standalone-demo
      domain: startcloud.com
      server_id: '4021'  # Used for partition_id

      # Resources
      vcpus: 4
      memory: 16G

      # Box
      box: 'STARTcloud/debian13-server'
      box_version: 2025.8.13

      # Vagrant SSH
      vagrant_user: startcloud
      vagrant_user_pass: 'STARTcloud24@!'
      vagrant_user_private_key_path: ./id_rsa

    zones:
      vmtype: production
      brand: bhyve
      on_demand_vnics: true
      setup_method: zlogin
      booted_string: 'Web console:'
      lcheck_string: ':~$'
      alcheck_string: 'login:'

    networks:
      - type: external
        address: 10.12.0.149
        netmask: 255.255.255.0
        gateway: 10.12.0.1
        dhcp4: false
        bridge: "Intel(R) 82599 10 Gigabit Dual Port Network Connection"
        mac: 08:00:27:B4:E0:F2

    disks:
      boot:
        array: Array-1
        dataset: zones
        volume_name: boot
        size: 48G

    folders:
      - map: ./provisioners/ansible/
        to: /vagrant/ansible/
        type: rsync

    provisioning:
      ansible:
        enabled: true
        playbooks:
          - local:
              - playbook: ansible/generate-playbook.yml
                run: always
              - playbook: ansible/playbook.yml
                run: once

THIS IS NOT A COMPLETE LIST OF KEYS AND VALUES. REFER TO HOSTS.yml FOR FULL CONFIGURATION
```

---

## 3. Hosts.rb Processing Logic

### Main Configuration Loop

```ruby
settings['hosts'].each_with_index do |host, index|
  # For each host in Hosts.yml:

  1. Set provider (virtualbox, utm, zone)
  2. Define VM name: "{server_id}--{hostname}.{domain}"
  3. Configure SSH: username, password, key_path
  4. Process networks (create adapters)
  5. Process disks (create volumes)
  6. Register shared folders (rsync/scp)
  7. Run provisioners (shell, ansible)
  8. Post-provision hooks
end
```

### Network Processing (Lines 78-133)

```ruby
host['networks'].each_with_index do |network, netindex|
  # Get bridge interface (auto-detect or user-specified)
  bridge = network['bridge'] || get_bridge_interface()

  if network['type'] == 'external'
    server.vm.network "public_network",
      bridge: bridge,
      ip: network['address'],
      mac: network['mac'],  # Can be 'auto' or specific MAC
      nic_type: network['nic_type'],
      nic_number: netindex
  end

  # Network config passed to vagrant-zones provider
end
```

**Key Insight**: `mac: 'auto'` signals vagrant-zones to auto-generate MAC during VNIC creation

### MAC Address Update Trigger (Lines 138-214)

**For VirtualBox only** - After zone boots:
```ruby
config.trigger.after :up do |trigger|
  # Get VM info from VirtualBox
  vm_info = `VBoxManage showvminfo "{vm_name}" --machinereadable`

  # Extract MAC addresses for each adapter
  mac_addresses = {}
  vm_info.scan(/macaddress(\d+)="(.+?)"/).each do |adapter_num, mac|
    mac_addresses[adapter_num.to_i] = mac.upcase
  end

  # Update Hosts.yml with actual MACs (replace 'auto' with real MAC)
  # This allows subsequent runs to use the same MACs
end
```

**Purpose**: Persists auto-generated MACs back to Hosts.yml for consistency

### Provisioning Setup (Lines 496-583)

```ruby
if host['provisioning']['ansible']['enabled']
  host['provisioning']['ansible']['playbooks'].each do |playbooks|
    if playbooks.has_key?('local')
      # ansible_local provisioner (runs inside VM)
      playbooks['local'].each do |localplaybook|
        run_value = case localplaybook['run']
          when 'always' then :always
          when 'not_first' then File.exist?('results.yml') ? :always : :never
          else :once
        end

        server.vm.provision :ansible_local, run: run_value do |ansible|
          ansible.playbook = localplaybook['playbook']
          ansible.extra_vars = {
            settings: host['settings'],
            networks: host['networks'],
            disks: host['disks'],
            role_vars: host['vars'],
            provision_roles: host['roles']
          }
        end
      end
    end
  end
end
```

**Key Variables Passed to Ansible**:
- `settings`: All VM settings (hostname, vcpus, memory, etc.)
- `networks`: Network configs with MACs (updated with actual values)
- `disks`: Disk configurations
- `role_vars`: User-defined variables from `vars:` section
- `provision_roles`: Ansible roles to apply

---

## 4. Vagrant-Zones Provider Workflow

### Zone Creation Sequence

**Action: Import** → **Create** → **Network** → **Start** → **WaitTillBoot** → **Setup** → **WaitTillUp** → **Provision**

#### 1. Import (action/import.rb)
```
Purpose: Download/copy box image to local storage

For .zss files (ZFS snapshots):
  - Copy from cwd or use cached version at ~/.vagrant.d/boxes/

For templates:
  - Use existing ZFS dataset (no import needed)
```

#### 2. Create (action/create.rb)
```
Calls driver methods in sequence:
  1. create_dataset() - Create ZFS hierarchy
  2. zonecfg() - Configure zone via zonecfg
  3. install() - Install zone via zoneadm

ZFS Dataset Structure:
  {array}/{dataset}/{partition_id}--{hostname}.{domain}/
    ├── boot (ZFS volume for boot disk)
    ├── disk1 (additional disks)
    └── provisioning (for artifacts - NOT created by vagrant-zones)

Example: Array-1/zones/4021--standalone-demo.startcloud.com/boot

Zonecfg for bhyve:
  create -b
  set zonepath=/{array}/{dataset}/{partition_id}--{hostname}.{domain}/path
  set brand=bhyve
  set autoboot={true/false}
  set ip-type=exclusive
  add attr; set name=ram; set value={memory}; set type=string; end
  add attr; set name=vcpus; set value={cpus}; set type=string; end
  add attr; set name=bootrom; set value=BHYVE_RELEASE; set type=string; end
  add device; set match=/dev/zvol/rdsk/{boot_dataset}; end
```

#### 3. Network (action/network.rb)
```
Calls: driver.network(ui, 'create')

For each network in Hosts.yml:
  If type == 'external':
    1. zoneniccreate() - Create VNIC on physical bridge
       dladm create-vnic -l {bridge} -m {mac} {vnic_name}

  If type == 'host' or 'internal':
    1. etherstubcreate() - Create etherstub
    2. zonenatniccreate() - Create zone VNIC on etherstub
    3. etherstubcreatehvnic() - Create host VNIC with IP/NAT
    4. zonenatentries() - Configure IPFilter NAT
    5. zonedhcpentries() - Configure ISC DHCP

  Then:
    zonecfgnicconfig() - Add NIC to zone config
      zonecfg -z {name} "add net; set physical={vnic_name}; set global-nic={bridge}; ..."
```

**VNIC Naming**:
```ruby
vnicname = "vnic#{nictype}#{vtype}_#{partition_id}_#{nic_number}"

Example: vnice3_4021_0
  e = external
  3 = production
  4021 = partition_id from server_id
  0 = first NIC
```

#### 4. Start (action/start.rb)
```
Calls:
  1. driver.check_zone_support() - Preflight checks
  2. driver.boot() → pfexec zoneadm -z {name} boot
```

**Important**: This is when VNICs are created with their MACs (for on-demand mode)

#### 5. WaitTillBoot (action/wait_till_boot.rb)
```
Calls: driver.waitforboot()

Routes to:
  - zloginboot() for Linux/Unix
  - zlogin_win_boot() for Windows
  - natloginboot() for DHCP/SSH method
```

**zloginboot() Sequence**:
```ruby
def zloginboot(uii)
  pid, stdin, stdout, stderr = PTY.spawn("pfexec zlogin -C #{name}")

  # Wait for boot string
  expect(stdout, /#{config.booted_string}/, timeout: setup_wait)

  # Wait for login prompt
  expect(stdout, /#{config.alcheck}/, timeout: 30)  # 'login:'

  # Send username
  stdin.write("#{config.vagrant_user}\r\n")

  # Wait for password prompt
  expect(stdout, /Password:/, timeout: 30)

  # Send password
  stdin.write("#{config.vagrant_user_pass}\r\n")

  # Wait for shell prompt
  expect(stdout, /#{config.lcheck}/, timeout: 30)  # ':~$'

  # Elevate to root
  stdin.write("sudo su -\r\n")
  expect(stdout, /#/, timeout: 30)

  # Kill session
  Process.kill('HUP', pid)

  uii.info("Zone booted successfully")
end
```

**Boot Detection Patterns**:
- `booted_string`: 'Web console:' (from Hosts.yml line 82)
- `alcheck_string`: 'login:' (authentication prompt)
- `lcheck_string`: ':~$' (shell prompt)

#### 6. Setup (action/setup.rb)
```
Calls: driver.setup() → driver.network(ui, 'setup')

For setup_method == 'zlogin':
  Routes to zoneniczloginsetup_*() based on OS

For Linux/netplan:
  zoneniczloginsetup_netplan(ui, opts)
```

**Linux Network Setup Sequence**:
```ruby
def zoneniczloginsetup_netplan(uii, opts)
  # 1. Clear existing netplan configs
  zlogin(uii, "rm -rf /etc/netplan/*.yaml")

  # 2. Generate netplan YAML
  netplan_yaml = <<~YAML
    network:
      version: 2
      ethernets:
        #{opts[:vnic_name]}:
          match:
            macaddress: "#{opts[:mac]}"
          set-name: #{opts[:vnic_name]}
          addresses: [#{opts[:ip]}/#{CIDR[opts[:netmask]]}]
          routes:
            - to: default
              via: #{opts[:gateway]}
          nameservers:
            addresses: [#{dns_servers}]
  YAML

  # 3. Write netplan config via heredoc
  zlogin(uii, "cat > /etc/netplan/#{opts[:vnic_name]}.yaml << 'EOF'\n#{netplan_yaml}\nEOF")

  # 4. Set permissions
  zlogin(uii, "chmod 600 /etc/netplan/#{opts[:vnic_name]}.yaml")

  # 5. Apply netplan
  zlogin(uii, "netplan apply")

  # 6. Verify interface
  zlogin(uii, "ip addr show #{opts[:vnic_name]}")
end
```

**Critical Detail**: The `match: macaddress` directive requires the ACTUAL MAC address from the running zone's VNIC. This is obtained from:

```ruby
# In driver.rb network() method
macs = execute(false, "#{pfexec} dladm show-vnic -p -o LINK,MACADDRESS #{name}")
  .split("\n")
  .map { |line| line.split(':') }
  .to_h

opts[:mac] = macs[opts[:vnic_name]]  # Get MAC for this VNIC
```

Then passed to zoneniczloginsetup_netplan().

#### 7. WaitTillUp (action/wait_till_up.rb)
```
Polls: machine.communicate.ready?()

This checks SSH connectivity using:
  - host: IP from get_ip_address()
  - port: 22
  - username: vagrant_user
  - password: vagrant_user_pass
  - private_key_path: vagrant_user_private_key_path

Retries until SSH responds or timeout
```

#### 8. Provision (Vagrant standard)
```
Runs provisioners in order:
  1. Shell provisioners (if enabled)
  2. Ansible-local provisioners

For ansible_local:
  - Ansible runs INSIDE the VM
  - Playbooks synced via rsync/scp to /vagrant/
  - Collections synced to /vagrant/ansible_collections/
  - Extra vars include all Hosts.yml settings
```

---

## 3. MAC Address Handling (The Critical Part)

### Problem Statement
- On-demand VNICs get random MACs during zone boot
- Network configuration needs these MACs to match interfaces
- NICs defined in zonecfg MAY NOT map to OS interface order

### Vagrant-Zones Solution

#### Phase 1: Zone Creation (MAC Unknown)
```ruby
# In Hosts.yml
networks:
  - type: external
    mac: 08:00:27:B4:E0:F2  # User-specified
    # OR
    mac: auto  # System-generated
```

#### Phase 2: Zone Boot (MACs Created)
```
zoneadm -z {name} boot
  ↓
Bhyve creates VNICs with:
  - User-specified MAC (if set in zonecfg)
  - OR random MAC (if not specified)
```

#### Phase 3: MAC Discovery (During Setup)
```ruby
# In driver.rb network() method, 'setup' mode

# Get all VNICs for this zone
vnics_output = execute(false, "#{pfexec} dladm show-vnic -p -o LINK,MACADDRESS,ZONE | grep #{name}")

# Parse to hash: {vnic_name => mac_address}
macs = vnics_output.split("\n").map { |line|
  parts = line.split(':')
  [parts[0], parts[1]]  # [vnic_name, mac]
}.to_h

# Example output:
# {
#   "vnice3_4021_0" => "02:08:20:75:e9:9a",
#   "vnice3_4021_1" => "02:08:20:e9:be:38"
# }
```

#### Phase 4: Network Configuration (MAC Used)
```ruby
# For each network config
opts = {
  vnic_name: "vnice3_4021_0",
  mac: macs["vnice3_4021_0"],  # Retrieved from dladm
  ip: network['address'],
  netmask: network['netmask'],
  gateway: network['gateway']
}

zoneniczloginsetup_netplan(ui, opts)
  # Generates netplan with:
  # match: macaddress: "02:08:20:75:e9:9a"
  # set-name: vnice3_4021_0
```

### For VirtualBox: MAC Persistence
```ruby
# After provision, trigger updates Hosts.yml
config.trigger.after :up do |trigger|
  # Find lines with mac: auto
  # Replace with actual MAC from VBoxManage showvminfo
  # Write back to Hosts.yml
end
```

**Result**: Next `vagrant up` uses same MACs instead of regenerating

---

## 4. Network Types & Configuration

### External Network (Public/Bridged)
```yaml
- type: external
  bridge: "ixgbe1"  # Physical interface
  address: 10.12.0.149
  gateway: 10.12.0.1
  dhcp4: false
  vlan: 11  # Optional
```

**Implementation**:
```ruby
zoneniccreate():
  vnic_name = "vnice3_{partition_id}_{nic_number}"
  execute("#{pfexec} dladm create-vnic -l #{bridge} -v #{vlan} -m #{mac} #{vnic_name}")

zonecfgnicconfig():
  execute("#{pfexec} zonecfg -z #{name} 'add net; set physical=#{vnic_name}; set global-nic=#{bridge}; ...'")
```

### Internal Network (Etherstub/NAT)
```yaml
- type: host
  address: 10.190.190.10
  gateway: 10.190.190.1
  dhcp4: true
```

**Implementation**:
```ruby
etherstubcreate():
  etherstub = "stub_{partition_id}_{nic_number}"
  execute("#{pfexec} dladm create-etherstub #{etherstub}")

zonenatniccreate():
  vnic_name = "vnici3_{partition_id}_{nic_number}"
  execute("#{pfexec} dladm create-vnic -l #{etherstub} -m #{mac} #{vnic_name}")

etherstubcreatehvnic():
  hvnic = "h_vnic_{partition_id}_{nic_number}"
  execute("#{pfexec} dladm create-vnic -l #{etherstub} #{hvnic}")
  execute("#{pfexec} ipadm create-addr -T static -a #{gateway}/#{CIDR} #{hvnic}/v4")
  execute("#{pfexec} ipadm set-ifprop -p forwarding=on -m ipv4 #{hvnic}")

zonenatentries():
  # Add to /etc/ipf/ipnat.conf
  echo "map #{bridge} #{broadcast}/#{CIDR} -> 0/32" >> /etc/ipf/ipnat.conf
  svcadm refresh ipfilter

zonedhcpentries():
  # Add to /etc/inet/dhcpd.conf
  subnet #{broadcast} netmask #{netmask} {
    option routers #{gateway};
    option domain-name-servers #{dns};
  }
  host #{zone_name} {
    hardware ethernet #{mac};
    fixed-address #{ip};
  }
  svcadm restart dhcp
```

---

## 5. Zlogin Automation Deep Dive

### PTY-Based Command Execution

**Core Pattern**:
```ruby
def zlogin(uii, cmd)
  pid, stdin, stdout, stderr = PTY.spawn("pfexec zlogin -C #{name}")

  # Send command
  stdin.write("#{cmd}\r\n")

  # Send error code check
  stdin.write("echo \"Error Code: $?\"\r\n")

  # Read output until error code appears
  output = ""
  Timeout.timeout(config.setup_wait) do
    stdout.each_line do |line|
      output += line
      break if line.include?("Error Code:")
    end
  end

  # Extract error code
  lines = output.split("\n")
  error_code = lines[-2].match(/Error Code: (\d+)/)[1].to_i

  # Kill session
  Process.kill('HUP', pid)

  raise ExecuteError if error_code != 0

  return output
end
```

**Key Characteristics**:
- Opens `zlogin -C` session for each command (not persistent)
- Kills session after command completes (frees console)
- Uses exit code detection for error handling
- ANSI codes NOT stripped (relies on pattern matching with codes)

### Boot Detection vs Command Execution

**zloginboot()** - ONE session for entire boot sequence:
```ruby
PTY.spawn("zlogin -C") → keep alive
  ↓
Wait for boot string
  ↓
Login sequence (username, password, sudo)
  ↓
Kill session
```

**zlogin(cmd)** - NEW session per command:
```ruby
PTY.spawn("zlogin -C") → execute command → kill session
```

**Why the difference?**
- Boot needs continuous monitoring
- Commands are one-shot operations that should release the console

---

## 6. SSH Key Management

### Core Provisioner SSH Keys

**Location**: `./core/ssh_keys/id_rsa` (relative to Vagrantfile)

**Purpose**: Pre-generated SSH key for consistent access across rebuilds

**Usage in Hosts.rb (Line 44-46)**:
```ruby
default_ssh_key = "./core/ssh_keys/id_rsa"
vagrant_ssh_key = host['settings']['vagrant_user_private_key_path']
server.ssh.private_key_path = File.exist?(vagrant_ssh_key) ? [vagrant_ssh_key, default_ssh_key] : default_ssh_key
```

**Key Insertion Disabled (Line 47)**:
```ruby
server.ssh.insert_key = false
```

**Why?** Vagrant normally generates a new key on first boot. This disables that so the pre-existing `./core/ssh_keys/id_rsa` is used.

### SSH Key in Zone

**During rsync/scp sync**:
```yaml
folders:
  - map: ./provisioners/ansible/
    to: /vagrant/ansible/
    type: rsync
```

The core provisioner directory (containing ssh_keys/) gets synced to `/vagrant/` inside the zone.

**Post-Provision Key Sync (Lines 695-701)**:
```ruby
if host['settings']['vagrant_ssh_insert_key']
  # Transfer new key from VM to host (after lockdown role generates new key)
  system("vagrant scp :/home/startcloud/.ssh/id_ssh_rsa #{vagrant_user_private_key_path}")

  # Remove vagrantup public key from VM
  system("vagrant ssh -c \"sed -i '/vagrantup/d' /home/startcloud/.ssh/id_ssh_rsa\"")
end
```

**Purpose**: The lockdown Ansible role generates a NEW SSH key for security. This key is synced back to host for future access.

---

## 7. Folder Syncing (rsync/scp)

### Sync Types

**1. rsync (requires rsync in VM)**:
```yaml
folders:
  - map: ./provisioners/ansible/
    to: /vagrant/ansible/
    type: rsync
    args:
      - '--verbose'
      - '--archive'
      - '--delete'
      - '-z'
      - '--copy-links'
```

**2. scp (via vagrant-scp-sync plugin)**:
```yaml
folders:
  - map: ./ssls/
    to: /secure/
    type: scp
```

**3. Syncback (VM → Host)**:
```yaml
folders:
  - map: ./id-files/
    to: /id-files/
    type: rsync
    syncback: true
```

**Implementation (Lines 614-629)**:
```ruby
config.trigger.after :rsync, type: :command do |trigger|
  guest_path = folder['to']
  host_path = folder['map']
  system("vagrant scp :#{guest_path} #{host_path}")
end
```

### Sync Timing

**Initial Sync**: Before provisioners run (Vagrant standard synced_folders action)

**Update Sync**: `vagrant rsync` command (manual or triggered)

**Syncback**: After :rsync command via trigger

---

## 8. Provisioning Workflow

### Ansible-Local Execution

**Playbook 1: generate-playbook.yml** (run: always)
```
Purpose: Transform Hosts.yml into Ansible playbook
Input: host['settings'], host['networks'], host['vars'], host['roles']
Output: /vagrant/ansible/playbook.yml (generated)
```

**Playbook 2: playbook.yml** (run: once)
```
Purpose: Configure machine with generated playbook
Collections: startcloud.startcloud_roles, startcloud.hcl_roles
Run condition: First provision only (unless results.yml deleted)
```

**Playbook 3: always-playbook.yml** (run: not_first)
```
Purpose: Apply roles tagged 'always' (like networking role)
Collections: startcloud.startcloud_roles
Run condition: Every provision EXCEPT first
```

### Ansible Extra Vars

```ruby
ansible.extra_vars = {
  settings: {
    hostname: 'standalone-demo',
    domain: 'startcloud.com',
    vcpus: 4,
    memory: '16G',
    vagrant_user: 'startcloud',
    # ... all settings from Hosts.yml
  },
  networks: [
    {
      type: 'external',
      address: '10.12.0.149',
      mac: '08:00:27:B4:E0:F2',  # ACTUAL MAC (updated by trigger)
      # ... all network settings
    }
  ],
  disks: { boot: {...}, additional_disks: [...] },
  role_vars: { domino_organization: 'STARTcloud', ... },
  provision_roles: [
    { name: 'startcloud.startcloud_roles.setup' },
    { name: 'startcloud.startcloud_roles.networking', tags: 'always' },
    # ... all roles
  ]
}
```

**Key Point**: `networks[].mac` contains the ACTUAL MAC address retrieved from `dladm show-vnic` during the setup phase.

---

## 9. Comparison: Vagrant-Zones vs Zoneweaver-API

### Vagrant-Zones Approach

```
1. Zone created with zonecfg (NICs defined, no MACs yet)
2. Zone boots → VNICs created → MACs assigned
3. dladm show-vnic queries actual MACs
4. zlogin session runs network setup with actual MACs
5. SSH becomes available
6. Ansible provisioners run via SSH
```

**MAC Retrieval**:
```ruby
macs = execute(false, "#{pfexec} dladm show-vnic -p -o LINK,MACADDRESS #{name}")
```

**Network Setup via Zlogin**:
```ruby
zlogin(ui, "cat > /etc/netplan/vnice3_4021_0.yaml << EOF\n...\nEOF")
zlogin(ui, "netplan apply")
```

**SSH Wait**:
```ruby
# Vagrant's built-in SSH ready check
machine.communicate.ready?()
```

### Zoneweaver-API Current Approach

```
1. Zone created with zonecfg (NICs defined, no MACs yet)
2. Zone boots → VNICs created → MACs assigned
3. ??? MACs need to be retrieved ???
4. ZloginAutomation runs recipe with MAC variables
5. SSH wait via SSHManager.waitForSSH()
6. File sync via rsync
7. Provisioners run via SSH
```

**Gap**: Step 3 - How do we get the MACs?

### Solution Proposal

**Option A: Query MACs in ZoneSetupManager (Current Implementation)**
```javascript
// In ZoneSetupManager.js, before running recipe
const zoneConfig = await getZoneConfig(zone_name);  // Uses zadm show
const nics = zoneConfig?.net || [];

// Find provisioning NIC by global-nic match
const provNic = nics.find(nic => nic['global-nic'] === 'estub_vz_1');
const mac = provNic?.mac;  // Get actual MAC

// Auto-populate variables
if (!variables.mac) {
  variables.mac = mac;
}
```

**Option B: Query via dladm (Like vagrant-zones)**
```javascript
// Execute: dladm show-vnic -p -o LINK,MACADDRESS -z {zone_name}
const result = await executeCommand(`pfexec dladm show-vnic -p -o LINK,MACADDRESS -z ${zone_name}`);

// Parse output to get MAC for each VNIC
const macs = {};
result.output.split('\n').forEach(line => {
  const [vnic, mac] = line.split(':');
  macs[vnic] = mac;
});

// Use provisioning VNIC's MAC
variables.mac = macs['vnici3_0001_0'];
```

**Recommendation**: Option A (zadm show) is cleaner as it leverages existing zone config parsing

---

## 10. Key Differences: Vagrant vs Zoneweaver

| Aspect | Vagrant-Zones | Zoneweaver-API |
|--------|---------------|----------------|
| **MAC Discovery** | `dladm show-vnic` during setup | `zadm show` in ZoneSetupManager |
| **Network Setup** | `zlogin()` function per command | ZloginAutomation.execute() with recipe |
| **Boot Detection** | `zloginboot()` - PTY session | ZloginAutomation waits for boot_string |
| **Exit Code** | `echo "Error Code: $?"` | `echo "ZWEC_{timestamp}:$?"` |
| **Session Handling** | New session per command | Persistent PTY via ZloginPtyManager |
| **SSH Wait** | `machine.communicate.ready?` | SSHManager.waitForSSH() |
| **Provisioners** | Vagrant provisioners (shell/ansible) | Custom orchestration with shell/ansible |
| **File Sync** | Vagrant synced_folders (rsync/scp) | SSHManager.syncFiles() |

---

## 11. Critical Vagrant-Zones Functions (from driver.rb)

### Boot Detection
```ruby
def zloginboot(uii)
  # Purpose: Wait for zone to boot and become accessible
  # Method: Serial console (zlogin -C) with expect patterns
  # Duration: Measured and logged for performance tracking
  # Output: Boot time in seconds
end
```

### Network Setup (Per OS)
```ruby
def zoneniczloginsetup_netplan(uii, opts)
  # OS: Linux with netplan (Debian, Ubuntu)
  # Generates: /etc/netplan/{vnic_name}.yaml with match on MAC
  # Applies: netplan apply
end

def zoneniczloginsetup_dladm(uii, opts)
  # OS: illumos/SunOS
  # Method: dladm rename-link, ipadm create-addr
  # Routes: route -p add default {gateway}
end

def zoneniczloginsetup_windows(uii, opts)
  # OS: Windows
  # Method: getmac to find adapter, netsh to configure
  # Delay: 120s for Windows profile creation (Windows_profile_wait)
end
```

### IP Address Discovery
```ruby
def get_ip_address(uii)
  if config.dhcp4
    # Login to zone and query IP
    result = zlogin(uii, "ip -4 addr show dev #{vnic_name} | grep -Po 'inet \\K[0-9.]+'")
    return result.strip
  else
    # Static IP from config
    return config.networks[0][:ip]
  end
end
```

---

## 12. Integration Points for Zoneweaver-API

### What Zoneweaver Should Adopt

#### 1. MAC Discovery Pattern
```javascript
// After zone boots, before recipe runs
const getMacForVnic = async (zoneName, vnicName) => {
  const result = await executeCommand(
    `pfexec dladm show-vnic -p -o LINK,MACADDRESS -z ${zoneName}`
  );

  const macs = {};
  result.output.split('\n').forEach(line => {
    const [vnic, mac] = line.split(':');
    if (vnic) macs[vnic.trim()] = mac.trim();
  });

  return macs[vnicName];
};
```

#### 2. Provisioning NIC Identification
```javascript
// Find which NIC is the provisioning network
const findProvisioningNic = (zoneConfig, provisioningNetwork) => {
  // provisioningNetwork = 'estub_vz_1' from config
  const nics = zoneConfig.net || [];
  return nics.find(nic => nic['global-nic'] === provisioningNetwork);
};
```

#### 3. Network Setup via Recipe Variables
```yaml
# Recipe variables should include:
variables:
  vnic_name: vnici3_0001_0  # Auto-generated
  mac: 02:08:20:75:e9:9a     # Auto-detected from dladm
  ip: 10.190.190.10
  prefix: 24
  gateway: 10.190.190.1
  dns: 8.8.8.8
```

#### 4. SSH Key Path Resolution
```javascript
// Like Hosts.rb lines 44-46
const sshKeyPaths = [];

// Custom key if exists
if (credentials.ssh_key_path && fs.existsSync(credentials.ssh_key_path)) {
  sshKeyPaths.push(credentials.ssh_key_path);
}

// Default core_provisioner key
const defaultKey = path.join(provisioningDatasetPath, 'core/ssh_keys/id_rsa');
if (fs.existsSync(defaultKey)) {
  sshKeyPaths.push(defaultKey);
}

// Try keys in order
for (const keyPath of sshKeyPaths) {
  const result = await testSSHConnection(ip, username, keyPath);
  if (result.success) return keyPath;
}
```

---

## 13. Provisioner Artifact Structure

### Directory Layout
```
hcl_domino_standalone_provisioner/
├── Vagrantfile (loads core/Hosts.rb)
├── Hosts.yml (zone configuration)
├── core/
│   ├── Vagrantfile (minimal wrapper)
│   ├── Hosts.rb (configuration processor)
│   ├── version.rb (CoreProvisioner::VERSION)
│   ├── ssh_keys/
│   │   ├── id_rsa (private key)
│   │   └── id_rsa.pub (public key)
│   └── examples/
│       └── Hosts.yml (template)
├── provisioners/
│   ├── ansible/ (playbooks)
│   │   ├── generate-playbook.yml
│   │   ├── playbook.yml (generated)
│   │   ├── always-playbook.yml
│   │   ├── ansible.cfg
│   │   └── requirements.yml
│   └── ansible_collections/ (Ansible collections)
│       ├── startcloud.startcloud_roles/
│       └── startcloud.hcl_roles/
├── installers/ (HCL software archives)
│   └── domino/archives/
├── ssls/ (SSL certificates)
└── id-files/ (Notes ID files)
```

### Artifact Extraction for Zoneweaver

**When extracted to** `/rpool/zones/{zone_name}/provisioning/`:
```
/rpool/zones/0001--test-debian13/provisioning/
└── hcl_domino_standalone_provisioner/
    ├── core/
    │   └── ssh_keys/id_rsa  ← SSH key for authentication
    ├── provisioners/
    │   ├── ansible/
    │   └── ansible_collections/
    ├── installers/
    └── ssls/
```

**SSH Key Path**: `hcl_domino_standalone_provisioner/core/ssh_keys/id_rsa`

**Sync Folders** (equivalent to Hosts.yml folders):
```javascript
sync_folders: [
  {
    source: '/rpool/zones/{zone}/provisioning/hcl_domino_standalone_provisioner/provisioners/ansible',
    dest: '/vagrant/ansible',
    exclude: []
  },
  {
    source: '/rpool/zones/{zone}/provisioning/hcl_domino_standalone_provisioner/provisioners/ansible_collections',
    dest: '/vagrant/ansible_collections',
    exclude: []
  }
]
```

---

## 14. Workflow Comparison

### Vagrant-Zones Full Flow

```
vagrant up
  ↓
1. Import box (ZFS snapshot or download)
2. Create ZFS datasets (Array-1/zones/4021--standalone-demo.startcloud.com/)
3. Configure zone (zonecfg with NICs, disks, attributes)
4. Install zone (zoneadm install)
5. Create networks:
   - Create VNIC on ixgbe1 (external)
   - Add VNIC to zonecfg
6. Boot zone (zoneadm boot) → VNICs created with random MACs
7. Wait for boot (zloginboot):
   - Watch serial console for 'Web console:'
   - Login with startcloud/STARTcloud24@!
   - Elevate to root (sudo su -)
8. Query MACs:
   - dladm show-vnic -p -o LINK,MACADDRESS {zone}
9. Setup network (zlogin commands):
   - rm -rf /etc/netplan/*.yaml
   - cat > /etc/netplan/vnice3_4021_0.yaml (with actual MAC)
   - netplan apply
10. Wait for SSH (machine.communicate.ready?)
11. Sync folders:
    - rsync ./provisioners/ansible/ → /vagrant/ansible/
    - rsync ./provisioners/ansible_collections/ → /vagrant/ansible_collections/
12. Run Ansible playbooks:
    - generate-playbook.yml (always)
    - playbook.yml (once)
    - always-playbook.yml (not_first)
13. Post-provision:
    - Sync back id-files
    - Sync back support bundle
    - Update Hosts.yml with actual MACs (VirtualBox only)
```

### Zoneweaver-API Current Flow

```
POST /zones/{name}/provision
  ↓
1. Extract artifact → /rpool/zones/{zone}/provisioning/
   - Fix ownership: chown -R zoneapi:other
   - Fix SSH key perms: chmod 600 id_rsa
2. Boot zone (zoneadm boot) → VNICs created with random MACs
3. Wait for boot (ZloginAutomation):
   - Watch for boot_string
   - Login with credentials
   - Elevate to root
4. Query MACs:
   - zadm show (includes NICs with MACs) ← CURRENT
   - OR dladm show-vnic ← VAGRANT-ZONES METHOD
5. Setup network (ZloginAutomation recipe):
   - Auto-populate variables.mac from step 4
   - Run recipe steps (rm netplan, cat heredoc, netplan apply)
6. Wait for SSH (SSHManager.waitForSSH):
   - Poll SSH with key from artifact
7. Sync files (SSHManager.syncFiles):
   - rsync provisioning dataset → /vagrant/
8. Run provisioners:
   - Shell scripts via executeSSHCommand
   - Ansible playbooks (future)
```

---

## 15. The MAC Address Problem - Solved

### The Issue
- User creates zone with 2 NICs (provisioning + external)
- Provisioning config doesn't know MAC addresses (they're random)
- Recipe needs MAC to configure netplan
- User shouldn't have to manually discover and set MACs

### Vagrant-Zones Solution (Authoritative)

**Step 1: Boot zone (no network config yet)**
```ruby
driver.boot()  # zoneadm boot
```

**Step 2: Discover MACs immediately after boot**
```ruby
def network(ui, mode)
  if mode == 'setup'
    # Query all VNICs for this zone
    macs_output = execute(false, "#{pfexec} dladm show-vnic -p -o LINK,MACADDRESS,ZONE")
    zone_vnics = macs_output.split("\n").select { |line| line.include?(name) }

    macs = {}
    zone_vnics.each do |line|
      parts = line.split(':')
      vnic_name = parts[0]  # "vnice3_4021_0"
      mac_addr = parts[1]   # "02:08:20:75:e9:9a"
      macs[vnic_name] = mac_addr
    end

    # For each network in config
    config.networks.each do |net_opts|
      net_opts[:mac] = macs[net_opts[:vnic_name]]
      zoneniczloginsetup_netplan(ui, net_opts)
    end
  end
end
```

**Step 3: Use MAC in network setup**
```ruby
def zoneniczloginsetup_netplan(uii, opts)
  # opts[:mac] now contains actual MAC from dladm

  netplan_yaml = <<~YAML
    network:
      ethernets:
        #{opts[:vnic_name]}:
          match:
            macaddress: "#{opts[:mac]}"  # ← ACTUAL MAC
          set-name: #{opts[:vnic_name]}
          addresses: [#{opts[:ip]}/#{prefix}]
  YAML

  zlogin(uii, "cat > /etc/netplan/#{opts[:vnic_name]}.yaml << 'EOF'\n#{netplan_yaml}\nEOF")
  zlogin(uii, "netplan apply")
end
```

### Zoneweaver-API Equivalent

**Current Implementation in ZoneSetupManager.js**:
```javascript
// Get zone NICs for MAC auto-detection
const zoneConfig = await getZoneConfig(zone_name);  // zadm show
const nics = zoneConfig?.net || [];

// Auto-detect MAC if not provided
if (!variables.mac && nics.length > 0 && nics[0].mac) {
  variables.mac = nics[0].mac;
  log.task.info('Auto-detected MAC address from first NIC');
}
```

**Issues with Current Approach**:
1. ✅ Gets MACs from running zone
2. ❌ Assumes first NIC is provisioning network
3. ❌ Doesn't match by global-nic or nic_type

**Improved Approach**:
```javascript
// Find provisioning NIC by global-nic
const provConfig = config.get('provisioning.network') || {};
const provGlobalNic = provConfig.global_nic || 'estub_vz_1';

const provNic = nics.find(nic => nic['global-nic'] === provGlobalNic);
if (provNic && provNic.mac) {
  variables.mac = provNic.mac;
  log.task.info('Auto-detected MAC for provisioning network', {
    global_nic: provGlobalNic,
    vnic_name: provNic.physical,
    mac: provNic.mac
  });
}
```

---

## 16. Zlogin Command Execution Patterns

### Vagrant-Zones Pattern
```ruby
def zlogin(uii, cmd)
  pid, stdin, stdout = PTY.spawn("pfexec zlogin -C #{name}")

  stdin.write("#{cmd}\r\n")
  stdin.write("echo \"Error Code: $?\"\r\n")

  output = ""
  stdout.each_line do |line|
    output += line
    break if line.include?("Error Code:")
  end

  # Extract exit code from 2nd-to-last line
  exit_code = output.split("\n")[-2].match(/(\d+)/)[1].to_i

  Process.kill('HUP', pid)  # Close session

  raise ExecuteError if exit_code != 0
  return output
end
```

**Characteristics**:
- New session per command
- Inline error code detection
- Session killed after each command
- Synchronous execution

### Zoneweaver Pattern (Current)
```javascript
// In ZloginAutomation.js
const marker = `ZWEC_${Date.now()}`;
ptyManager.write(zoneName, `${command}; echo "${marker}:$?"\r\n`);
const result = await ptyManager.waitForPattern(
  zoneName,
  `${marker}:\\d`,
  timeout,
  globalDeadline,
  { useRegex: true }
);

// Extract exit code
const match = result.matched.match(/(\d+)/);
const exitCode = match ? parseInt(match[1]) : -1;
```

**Characteristics**:
- Persistent PTY session (shared via ZloginPtyManager)
- Timestamped markers for exit codes
- Regex-based pattern matching
- Asynchronous with global timeout

**Key Similarity**: Both use exit code marker pattern, just different implementations

---

## 17. Complete Provisioning Pipeline

### Vagrant-Zones (Reference Implementation)

```
User runs: vagrant up

1. IMPORT PHASE
   ├─ Check if box cached locally
   ├─ Download if needed (from box_url)
   └─ Store in ~/.vagrant.d/boxes/

2. CREATION PHASE
   ├─ Generate UUID for machine.id
   ├─ Create ZFS datasets:
   │  ├─ pfexec zfs create Array-1/zones/4021--standalone-demo.startcloud.com
   │  └─ pfexec zfs create -V 48G Array-1/zones/4021--standalone-demo.startcloud.com/boot
   ├─ Import template:
   │  └─ pv {box.zss} | pfexec zfs recv -u -v -F {dataset}
   └─ Configure zone (zonecfg):
      ├─ set zonepath=/Array-1/zones/4021--standalone-demo.startcloud.com/path
      ├─ set brand=bhyve
      ├─ add attr name=ram value=16G
      ├─ add attr name=vcpus value=4
      ├─ add attr name=bootrom value=BHYVE_RELEASE
      ├─ add attr name=acpi value=on
      └─ (NICs added in next phase)

3. NETWORK PHASE (Create VNICs)
   For external network:
   ├─ pfexec dladm create-vnic -l ixgbe1 -m 08:00:27:B4:E0:F2 vnice3_4021_0
   └─ pfexec zonecfg -z {name} "add net; set physical=vnice3_4021_0; set global-nic=ixgbe1; ..."

4. INSTALL PHASE
   └─ pfexec zoneadm -z {name} install

5. BOOT PHASE
   ├─ pfexec zoneadm -z {name} boot
   └─ VNICs created (MACs assigned by system)

6. BOOT DETECTION (zloginboot)
   ├─ pfexec zlogin -C {name}
   ├─ Wait for: "Web console:"
   ├─ Wait for: "login:"
   ├─ Send: "startcloud\r\n"
   ├─ Wait for: "Password:"
   ├─ Send: "STARTcloud24@!\r\n"
   ├─ Wait for: ":~$"
   ├─ Send: "sudo su -\r\n"
   ├─ Wait for: "#"
   └─ Kill session (HUP signal)

7. MAC DISCOVERY
   ├─ pfexec dladm show-vnic -p -o LINK,MACADDRESS {zone}
   ├─ Parse: vnice3_4021_0:02:08:20:75:e9:9a
   └─ Store in macs hash

8. NETWORK SETUP (zloginsetup)
   ├─ For each network config:
   │  ├─ Get MAC from macs hash
   │  └─ Call zoneniczloginsetup_netplan(ui, opts)
   │
   └─ zoneniczloginsetup_netplan:
      ├─ zlogin: rm -rf /etc/netplan/*.yaml
      ├─ zlogin: cat > /etc/netplan/vnice3_4021_0.yaml << EOF (with MAC)
      ├─ zlogin: chmod 600 /etc/netplan/vnice3_4021_0.yaml
      ├─ zlogin: netplan apply
      └─ zlogin: ip addr show vnice3_4021_0

9. SSH WAIT
   └─ Poll machine.communicate.ready?() until SSH responds

10. FOLDER SYNC
    ├─ rsync ./provisioners/ansible/ → /vagrant/ansible/
    ├─ rsync ./provisioners/ansible_collections/ → /vagrant/ansible_collections/
    ├─ rsync ./installers/ → /vagrant/installers/
    └─ rsync ./ssls/ → /secure/

11. ANSIBLE PROVISIONING
    ├─ Playbook 1 (always):
    │  └─ generate-playbook.yml - Transforms Hosts.yml → playbook.yml
    │
    ├─ Playbook 2 (once):
    │  └─ playbook.yml - Applies roles (Domino install, config, etc.)
    │
    └─ Playbook 3 (not_first):
       └─ always-playbook.yml - Roles tagged 'always'

12. POST-PROVISION
    ├─ Sync back id-files (if syncback: true)
    ├─ Sync back support bundle
    └─ Update Hosts.yml with actual MACs (VirtualBox only)
```

---

## 18. Critical Insights for Zoneweaver-API

### 1. MAC Discovery Must Happen After Boot
```
Zone boots → VNICs created → Query dladm → Get MACs → Configure network
```
**You CANNOT know MACs before boot with on-demand VNICs**

### 2. Provisioning Network Identification

**Vagrant-Zones Method**:
- Networks listed in Hosts.yml in specific order
- First network with `type: external` or `provisional: true`
- Matched by array index to dladm output

**Better Method for Zoneweaver**:
- Match by `global-nic` property (e.g., 'estub_vz_1')
- Each NIC in zonecfg has unique global-nic
- Query zone config after boot, find NIC with global-nic match
- Get that NIC's MAC from zadm show or dladm

### 3. VNIC Naming Convention

**Formula**: `vnic{nictype}{vmtype}_{partition_id}_{nic_index}`

- nictype: e=external, i=internal, c=carp, m=management, h=host
- vmtype: 1=template, 2=development, 3=production, 4=firewall, 5=other
- partition_id: Zone group identifier (4 digits)
- nic_index: 0-based index from zonecfg order

**Example**: `vnice3_0001_0`
- e = external network
- 3 = production VM
- 0001 = partition ID
- 0 = first NIC

**This naming is DETERMINISTIC** - we know which VNIC is which by the name alone.

### 4. Zone Path Structure

**Correct**: `/{dataset}/{zone_name}/path`

**Example**: `/rpool/zones/0001--test-debian13/path`

**NOT**: `/rpool/zones/0001--test-debian13` (missing /path)

**Why**: bhyve zones have subdirectories:
- `/path` - Zone root filesystem
- `/root` - Boot volume ZFS dataset
- `/provisioning` - Provisioning artifact storage (custom)

### 5. Zonepath Permissions Issue

**Observed Behavior**:
- `zoneadm install` creates zonepath with 700 (root:root)
- `zoneadm boot/halt` resets zonepath to 700 (security)
- Service user (zoneapi) cannot traverse into zonepath
- SSH keys in provisioning/ become inaccessible

**Vagrant-Zones Doesn't Have This Issue Because**:
- Runs as root or with sudo/pfexec for ALL operations
- Doesn't need persistent file access between operations
- Each command elevates privileges independently

**Zoneweaver-API Needs**:
- Service runs as non-root (zoneapi user)
- Needs persistent access to SSH keys in zonepath/provisioning/
- Must fix permissions after each boot

**Solution**:
```javascript
// In executeStartTask() - AFTER zoneadm boot
await executeCommand(`pfexec chmod 755 ${zonepath}`);
```

This must run EVERY boot, not just during creation.

---

## 19. Recommendations for Zoneweaver-API

### 1. MAC Auto-Detection (Implement Like Vagrant-Zones)

```javascript
// In ZoneSetupManager.js, BEFORE running recipe

async function autoDetectNetworkVariables(zoneName, provisioningConfig) {
  // Get provisioning network identifier from config
  const provNetworkGlobalNic = config.get('provisioning.network.global_nic') || 'estub_vz_1';

  // Query zone configuration
  const zoneConfig = await getZoneConfig(zoneName);  // zadm show
  const nics = zoneConfig?.net || [];

  // Find provisioning NIC by global-nic match
  const provNic = nics.find(nic => nic['global-nic'] === provNetworkGlobalNic);

  if (!provNic) {
    throw new Error(`Provisioning network not found (global-nic: ${provNetworkGlobalNic})`);
  }

  // Auto-populate MAC and vnic_name
  const variables = provisioningConfig.variables || {};

  if (!variables.mac) {
    variables.mac = provNic.mac || provNic['mac-addr'];
    log.task.info('Auto-detected MAC from provisioning NIC', {
      global_nic: provNetworkGlobalNic,
      vnic_name: provNic.physical,
      mac: variables.mac
    });
  }

  if (!variables.vnic_name) {
    variables.vnic_name = provNic.physical;
  }

  return variables;
}
```

### 2. Zonepath Permissions (Fix After Every Boot)

```javascript
// In ZoneManager.js executeStartTask()

export const executeStartTask = async zoneName => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} boot`);

  if (result.success) {
    // CRITICAL: Fix zonepath permissions immediately after boot
    // (zoneadm resets to 700 for security)
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (zone) {
      const zoneConfig = typeof zone.configuration === 'string'
        ? JSON.parse(zone.configuration)
        : zone.configuration;

      const zonepath = zoneConfig?.zonepath;
      if (zonepath) {
        const chmodResult = await executeCommand(`pfexec chmod 755 ${zonepath}`);
        if (!chmodResult.success) {
          log.task.warn('Failed to set zonepath permissions after boot', {
            zonepath,
            error: chmodResult.error
          });
        }
      }
    }

    // Update database
    await Zones.update(
      { status: 'running', last_seen: new Date() },
      { where: { name: zoneName } }
    );

    return { success: true, message: `Zone ${zoneName} started successfully` };
  }

  return { success: false, error: `Failed to start zone: ${result.error}` };
};
```

### 3. Provisioning NIC Config (Add to config.yaml)

```yaml
provisioning:
  network:
    global_nic: "estub_vz_1"  # Match by this
    nic_type: "internal"      # Or match by this
    # These identify which NIC is the provisioning network
```

### 4. Recipe Variables (Auto-Populated)

```javascript
// In ZoneSetupManager, before execute()
const enrichedVariables = {
  ...provisioningConfig.variables,  // User-provided

  // Auto-detected from zone config
  mac: provNic.mac,
  vnic_name: provNic.physical,

  // From provisioning config
  ip: provisioningConfig.ip,
  prefix: calculatePrefix(provisioningConfig.netmask || '255.255.255.0'),
  gateway: provisioningConfig.gateway,
  dns: provisioningConfig.dns || '8.8.8.8'
};

await automation.execute(recipe, enrichedVariables);
```

---

## 20. Summary of Key Findings

### What Vagrant-Zones Does Right
1. ✅ Queries MACs via `dladm show-vnic` after zone boots
2. ✅ Passes actual MACs to network setup functions
3. ✅ Uses serial console (zlogin) for early network config
4. ✅ Waits for SSH before running Ansible
5. ✅ Syncs provisioner files to /vagrant/ before provisioning
6. ✅ Deterministic VNIC naming based on config

### What Zoneweaver-API Needs to Fix
1. ❌ MAC auto-detection uses first NIC (should match by global-nic)
2. ❌ Zonepath permissions reset on boot (needs chmod 755 after every boot)
3. ⚠️  Recipe automation works but fragile (timing/buffer issues)

### What's Already Correct
1. ✅ Zonepath now includes `/path` suffix
2. ✅ Artifact extraction sets ownership to zoneapi
3. ✅ SSH key permissions set to 600
4. ✅ Partition ID prefixing for zone names
5. ✅ VNIC name auto-generation
6. ✅ Exit code extraction with regex markers

---

## 21. Next Steps for Implementation

### Immediate Fixes (Code Freeze Lifted)

**Fix 1: Add chmod 755 to zone start** (ZoneManager.js)
- AFTER zoneadm boot
- BEFORE database update
- Log warning if fails

**Fix 2: Improve MAC auto-detection** (ZoneSetupManager.js)
- Match by global-nic instead of first NIC
- Add config for provisioning network identifier
- Log which NIC was selected

**Fix 3: Add provisioning network config** (production-config.yaml)
```yaml
provisioning:
  network:
    global_nic: "estub_vz_1"
    nic_type: "internal"
```

### Testing Workflow

```bash
# 1. Create zone
curl -X POST "$BASE_URL/zones" ...

# 2. Set provisioning config (NO MAC needed)
curl -X PUT "$BASE_URL/zones/0001--test-debian13" -d '{
  "provisioning": {
    "artifact_id": "...",
    "recipe_id": "...",
    "ip": "10.190.190.10",
    "credentials": {
      "username": "startcloud",
      "password": "STARTcloud24@!",
      "ssh_key_path": "hcl_domino_standalone_provisioner/core/ssh_keys/id_rsa"
    },
    "variables": {
      "boot_string": "Booted - STARTcloud",
      "ip": "10.190.190.10",
      "prefix": "24",
      "gateway": "10.190.190.1",
      "dns": "8.8.8.8"
    }
  }
}'

# 3. Provision (auto-detects MAC, auto-sets zonepath permissions)
curl -X POST "$BASE_URL/zones/0001--test-debian13/provision"

# 4. Verify success
curl -s "$BASE_URL/tasks?zone_name=0001--test-debian13" | jq '.tasks[] | {operation, status}'
```

**Expected Results**:
- ✅ zone_provisioning_extract: completed
- ✅ start: completed (with chmod 755 on zonepath)
- ✅ zone_setup: completed (MAC auto-detected, network configured)
- ✅ zone_wait_ssh: completed (SSH keys accessible)
- ✅ zone_sync: completed (files synced to /vagrant)
- ✅ zone_provision: completed (if provisioners defined)

---

## End of Analysis

This document captures the complete vagrant-zones workflow and its integration with the HCL Domino provisioner. The key takeaway: **MAC addresses must be discovered after zone boot via dladm/zadm, then used for network configuration**.