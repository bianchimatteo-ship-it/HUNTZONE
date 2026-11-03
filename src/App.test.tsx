import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from './App';

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.location.hash = '';
});

beforeEach(() => {
  window.scrollTo = () => {};
});

describe('HUNTZONE local demo flow', () => {
  it('shows capture and role policies as an unapplied local preview', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /CREA PARTITA/i }));
    const pin = screen.getByRole('radio', { name: /PIN personale/i });
    const manual = screen.getByRole('radio', { name: /^Manuale/i });
    await user.click(pin);
    await user.click(manual);

    expect(pin).toHaveProperty('checked', true);
    expect(manual).toHaveProperty('checked', true);
    expect(screen.getByText(/Non influenzano la simulazione/i)).toBeTruthy();
    expect(screen.getByText(/soglie numeriche sono ancora da approvare/i)).toBeTruthy();
    expect(localStorage.getItem('huntzone.demo.config')).toContain('"captureMethod":"pin"');
  });

  it('creates a configured lobby, simulates a capture, ends the match and allows a rematch', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: /CREA PARTITA/i }));
    expect(screen.getByRole('heading', { name: /Prepara il campo/i })).toBeTruthy();

    fireEvent.change(screen.getByRole('slider', { name: /Raggio area di gioco/i }), { target: { value: '1550' } });
    expect(screen.getByText('1550')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /CREA LOBBY/i }));
    expect(screen.getByText('INVITE CODE')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /START SIMULATION/i }));
    expect(screen.getByText(/TIME REMAINING/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'HUNTER' }));
    const captureButton = screen.getAllByRole('button', { name: /TAG .*Virtual capture/i })[0];
    await user.click(captureButton);
    expect(screen.getByText(/1 TAGGED/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /TERMINA SIMULAZIONE/i }));
    expect(screen.getByText(/SIMULATION COMPLETE/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /RIVINCITA/i }));
    expect(screen.getByRole('heading', { name: /La squadra si prepara/i })).toBeTruthy();
  });
});
