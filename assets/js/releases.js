document.addEventListener('DOMContentLoaded', function() {
  // Only run on releases page
  if (window.location.pathname.includes('/releases/')) {
    const releaseDiv = document.getElementById('latest-release');
    if (releaseDiv) {
      // Fetch version from package.json
      fetch('https://raw.githubusercontent.com/Makr91/zoneweaver-api/refs/heads/main/package.json')
        .then(function(response) {
          return response.json();
        })
        .then(function(data) {
          releaseDiv.innerHTML = '<p><strong>Version v' + data.version + '</strong> - Current Build</p>';
        })
        .catch(function(error) {
          console.error('Error fetching version data:', error);
          releaseDiv.innerHTML = '<p><strong>Unable to load version information.</strong> Please visit <a href="https://github.com/Makr91/zoneweaver-api/releases">GitHub Releases</a> for the latest version.</p>';
        });
    }
  }
});
