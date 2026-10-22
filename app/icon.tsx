import { ImageResponse } from 'next/og';

export const size = {
  width: 64,
  height: 64,
};
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #0d9488 0%, #0f766e 100%)',
          borderRadius: 16,
          color: '#ffffff',
          fontSize: 30,
          fontWeight: 800,
          letterSpacing: '-0.04em',
        }}
      >
        Z
      </div>
    ),
    { ...size },
  );
}
