---
title: Changelog
layout: default
nav_order: 5
permalink: /docs/changelog/
---

# Changelog
{: .no_toc }

All notable changes to the ZoneWeaver API project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

{% raw %}
<div id="changelog-content">
  <p><em>Loading changelog...</em></p>
</div>

<script>
// Load changelog from main repository
fetch('https://raw.githubusercontent.com/Makr91/zoneweaver-api/main/CHANGELOG.md')
  .then(response => response.text())
  .then(markdown => {
    // Simple markdown-to-HTML conversion for basic changelog format
    let html = markdown
      // Convert headers
      .replace(/^## \[(.*?)\]/gm, '<h2>Version $1</h2>')
      .replace(/^### (.*)/gm, '<h3>$1</h3>')
      // Convert bullet points
      .replace(/^- (.*)/gm, '<li>$1</li>')
      // Wrap consecutive li elements in ul
      .replace(/(<li>.*<\/li>\n?)+/gs, '<ul>$&</ul>')
      // Convert links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      // Convert line breaks
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
    
    // Wrap in paragraphs
    html = '<p>' + html + '</p>';
    
    document.getElementById('changelog-content').innerHTML = html;
  })
  .catch(error => {
    document.getElementById('changelog-content').innerHTML = 
      '<p>Unable to load changelog. <a href="https://github.com/Makr91/zoneweaver-api/blob/main/CHANGELOG.md" target="_blank">View on GitHub</a></p>';
    console.log('Changelog loading error:', error);
  });
</script>
{% endraw %}
