---
title: Changelog
layout: default
nav_order: 4
permalink: /docs/changelog/
---

# Changelog
{: .no_toc }

All notable changes to the ZoneWeaver API project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

*This changelog is automatically updated from the main repository when new releases are published.*

**Current Version**: Loading...
{: #current-version }

**Release Date**: Loading...
{: #release-date }

**Release Notes**: [View on GitHub](#)
{: #release-notes }

<script>
// Load version information
fetch('version.json')
  .then(response => response.json())
  .then(data => {
    document.getElementById('current-version').textContent = 'Current Version: ' + data.version;
    document.getElementById('release-date').textContent = 'Release Date: ' + new Date(data.release_date).toLocaleDateString();
    document.getElementById('release-notes').innerHTML = 'Release Notes: <a href="' + data.release_url + '" target="_blank">View on GitHub</a>';
  })
  .catch(error => {
    console.log('Version info not available:', error);
  });
</script>

---

The changelog content will be automatically populated from CHANGELOG.md during the documentation build process.
