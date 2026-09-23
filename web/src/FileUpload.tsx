import React, { useState } from 'react';
import { uploadFile } from './messages';

export const FileUpload: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<boolean>(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      await uploadFile(file, (p) => setProgress(p));
      setUploaded(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div>
      <input type="file" onChange={handleChange} />
      <button onClick={handleUpload} disabled={!file || uploaded}>
        Upload
      </button>
      {progress > 0 && <progress value={progress} max={100} />}
      {error && <div className="error">{error}</div>}
      {uploaded && <div>Upload complete</div>}
    </div>
  );
};
