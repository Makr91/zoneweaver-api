---
title: Releases
layout: default
nav_order: 4
permalink: /docs/releases/
---

# Releases
{: .no_toc }

Download the latest version of ZoneWeaver API.

---

## Latest Release

<div id="latest-release">
<p>Loading latest release information...</p>
</div>

### Download Options

| Package Type | Platform | Download |
|:-------------|:---------|:---------|
| **OmniOS Package** | x86_64 | [📦 Download .p5p](https://github.com/Makr91/zoneweaver-api/releases/latest/download/zoneweaver-api.p5p){: .btn .btn-primary } |
| **Source Code** | All | [📁 Download Source](https://github.com/Makr91/zoneweaver-api/archive/refs/heads/main.tar.gz){: .btn .btn-outline } |

<script>
// Fetch latest release from GitHub API
fetch('https://api.github.com/repos/Makr91/zoneweaver-api/releases/latest')
  .then(response => response.json())
  .then(data => {
    const releaseDiv = document.getElementById('latest-release');
    const releaseDate = new Date(data.published_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long', 
      day: 'numeric'
    });
    
    releaseDiv.innerHTML = `
      <p><strong>Version ${data.tag_name}</strong> - Released ${releaseDate}</p>
      ${data.body ? `<details><summary>Release Notes</summary><div class="highlight">${data.body.replace(/\n/g, '<br>')}</div></details>` : ''}
    `;
  })
  .catch(error => {
    console.error('Error fetching release data:', error);
    document.getElementById('latest-release').innerHTML = 
      '<p><strong>Unable to load release information.</strong> Please visit <a href="https://github.com/Makr91/zoneweaver-api/releases">GitHub Releases</a> for the latest version.</p>';
  });
</script>

---

## Installation

- **[Production Installation](/docs/guides/production-installation/)** - Install using OmniOS packages
- **[Development Setup](/docs/guides/development-installation/)** - Set up development environment

---

## System Requirements

- **OS**: OmniOS (Latest stable)
- **Architecture**: x86_64
- **Memory**: 512MB+ RAM
- **Storage**: 1GB+ free space

---

## Release History

[📋 View Changelog](changelog/){: .btn .btn-outline }
[🔍 All Releases](https://github.com/Makr91/zoneweaver-api/releases){: .btn .btn-outline }
