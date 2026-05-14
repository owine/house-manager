import type { Metadata } from 'next';
import { SuggestClient } from './SuggestClient';

export const metadata: Metadata = { title: 'generate suggestion' };

export default function SuggestPage() {
  return <SuggestClient />;
}
