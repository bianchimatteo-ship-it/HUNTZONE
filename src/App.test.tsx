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
