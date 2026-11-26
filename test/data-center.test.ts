import * as Option from 'effect/Option'
import { expect, it } from 'vitest'
import {
  zohoDataCenterFromAccountsServer,
  zohoDataCenterFromApiDomain,
  zohoDataCenterFromLocation,
  zohoDataCenters,
} from '../src/index.ts'

it('finds the data centre from what Zoho sends back: the redirect location, the accounts server and the API domain', () => {
  expect(zohoDataCenterFromLocation('eu')).toEqual(Option.some('eu'))
  expect(zohoDataCenterFromAccountsServer('https://accounts.zohocloud.ca')).toEqual(Option.some('ca'))
  expect(zohoDataCenterFromApiDomain('https://www.zohoapis.com.au')).toEqual(Option.some('au'))
  for (const [dataCenter, hosts] of Object.entries(zohoDataCenters)) {
    expect(zohoDataCenterFromAccountsServer(hosts.accounts)).toEqual(Option.some(dataCenter))
    expect(zohoDataCenterFromApiDomain(hosts.api)).toEqual(Option.some(dataCenter))
  }
})

it('recognises only exact official origins', () => {
  for (const origin of ['https://accounts.zoho.eu.attacker.test', 'http://accounts.zoho.eu', 'https://accounts.zoho.eu/', 'https://www.zohoapis.eu']) {
    expect(zohoDataCenterFromAccountsServer(origin)).toEqual(Option.none())
  }
  expect(zohoDataCenterFromApiDomain('https://accounts.zoho.eu')).toEqual(Option.none())
  expect(zohoDataCenterFromLocation('EU')).toEqual(Option.none())
})
