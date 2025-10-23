const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;
function getEpisodeThumbnail(imageUrl, hideEpisodeThumbnails) {
  if (!imageUrl) {
    return `${host}/missing_thumbnail.png`;
  }
  
  if (hideEpisodeThumbnails) {
    return `${host}/api/image/blur?url=${encodeURIComponent(imageUrl)}`;
  }
  
  return imageUrl;
}

module.exports = { getEpisodeThumbnail };
