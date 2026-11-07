import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('real multiplayer entry point', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('does not show a demo roster or allow lobby creation while the API is unconfigured', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    const { default: App } = await import('./App');
    render(<App />);
    expect(await screen.findByText('SERVIZIO NON DISPONIBILE')).toBeTruthy();
    expect(screen.getByRole('button', { name: /CREA LOBBY REALE/i }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText('Mia')).toBeNull();
    expect(screen.queryByText('Luca')).toBeNull();
    expect(screen.queryByRole('list', { name: /partecipanti/i })).toBeNull();
    expect(screen.getByText(/Nessun bot/i)).toBeTruthy();
  });

  it('keeps lobby creation disabled when the configured service is unreachable', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://127.0.0.1:65534');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    vi.resetModules();
    const { default: App } = await import('./App');
    render(<App />);
    await waitFor(() => expect(screen.getByText('SERVIZIO NON DISPONIBILE')).toBeTruthy());
    expect(screen.getAllByRole('button', { name: /CREA LOBBY REALE/i }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByRole('button', { name: /UNISCITI ALLA LOBBY/i }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});
