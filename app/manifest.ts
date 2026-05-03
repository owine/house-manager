import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'House Manager',
    short_name: 'House Manager',
    description: 'Track home inventory, maintenance, warranties, and reminders.',
    start_url: '/dashboard',
    display: 'standalone',
    // Use the existing CSS theme tokens' background. Tailwind v4's bg-background
    // resolves to white in light mode; pick a neutral that works in both.
    background_color: '#ffffff',
    theme_color: '#0a0a0a',
    icons: [
      {
        src: '/icon.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
