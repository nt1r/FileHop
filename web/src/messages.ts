export async function uploadFile(file: File, onProgress?: (percent: number) => void) {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/upload', {
    method: 'POST',
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed: ${text}`);
  }
  const data = await response.json();
  return data;
}

export function downloadFile(id: string, filename: string) {
  const link = document.createElement('a');
  link.href = `/api/download/${id}`;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
