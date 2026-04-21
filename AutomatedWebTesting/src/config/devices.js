'use strict';

const { devices } = require('playwright');

const TEST_DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, name: 'Desktop' },
  '4k': { viewport: { width: 3840, height: 2160 }, name: '4K UHD' },
  iphone: { ...devices['iPhone 14 Pro'], name: 'iPhone 14 Pro' },
  pixel: { ...devices['Pixel 7'], name: 'Pixel 7' },
};

module.exports = TEST_DEVICES;
