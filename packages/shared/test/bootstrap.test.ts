import { describe, it, expect } from 'vitest'
import { PACKAGE_NAME } from '../src/index'
describe('bootstrap', () => { it('loads workspace', () => { expect(PACKAGE_NAME).toBe('@ashy/shared') }) })

