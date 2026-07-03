import { log } from './log';

declare const global: { __DEV__: boolean };

describe('log', () => {
  const spies = {
    log: jest.spyOn(console, 'log').mockImplementation(() => {}),
    info: jest.spyOn(console, 'info').mockImplementation(() => {}),
    warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
    error: jest.spyOn(console, 'error').mockImplementation(() => {}),
  };
  const originalDev = global.__DEV__;

  afterEach(() => {
    jest.clearAllMocks();
    global.__DEV__ = originalDev;
  });

  afterAll(() => {
    Object.values(spies).forEach((s) => s.mockRestore());
  });

  describe('in development (__DEV__ === true)', () => {
    beforeEach(() => {
      global.__DEV__ = true;
    });

    it('emits debug and info traces', () => {
      log.debug('[tag] trace', 1);
      log.info('[tag] info');
      expect(spies.log).toHaveBeenCalledWith('[tag] trace', 1);
      expect(spies.info).toHaveBeenCalledWith('[tag] info');
    });
  });

  describe('in production (__DEV__ === false)', () => {
    beforeEach(() => {
      global.__DEV__ = false;
    });

    it('suppresses debug and info traces', () => {
      log.debug('[tag] trace');
      log.info('[tag] info');
      expect(spies.log).not.toHaveBeenCalled();
      expect(spies.info).not.toHaveBeenCalled();
    });

    it('still emits warn and error', () => {
      log.warn('[tag] warn');
      log.error('[tag] boom', new Error('x'));
      expect(spies.warn).toHaveBeenCalledWith('[tag] warn');
      expect(spies.error).toHaveBeenCalledWith('[tag] boom', expect.any(Error));
    });
  });
});