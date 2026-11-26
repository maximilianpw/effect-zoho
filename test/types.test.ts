import { expectTypeOf, it } from 'vitest'
import type * as Effect from 'effect/Effect'
import type { ZohoError } from '../src/index.ts'
import { Invoices, type ZohoBinary, type ZohoBooksClient } from '../src/books/index.ts'
import { DeliveryChallans } from '../src/books/index.ts'

it('types inputs, results, failures and requirements from Zoho’s documents', () => {
  const invoice = Invoices.getInvoice({ invoice_id: '1' })
  type Invoice = NonNullable<Effect.Success<typeof invoice>['invoice']>

  expectTypeOf<Invoice['total']>().toEqualTypeOf<number | undefined>()
  expectTypeOf<Invoice['invoice_number']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<Invoice['is_viewed_by_client']>().toEqualTypeOf<boolean | undefined>()
  expectTypeOf<Effect.Error<typeof invoice>>().toEqualTypeOf<ZohoError>()
  expectTypeOf<Effect.Services<typeof invoice>>().toEqualTypeOf<ZohoBooksClient>()
  expectTypeOf(Invoices.listInvoices).toBeCallableWith()
  expectTypeOf(Invoices.listInvoices).toBeCallableWith({ page: 2 })
  expectTypeOf(Invoices.listInvoices).toBeCallableWith({ page: undefined, status: undefined })
  // @ts-expect-error a path parameter is required
  void Invoices.getInvoice()
  expectTypeOf<Parameters<typeof Invoices.getInvoice>>().toEqualTypeOf<[input: Invoices.GetInvoiceInput]>()
  expectTypeOf<Effect.Success<ReturnType<typeof DeliveryChallans.getDeliveryChallanAttachment>>>().toEqualTypeOf<ZohoBinary>()
  expectTypeOf<Effect.Error<typeof invoice>['reason']['_tag']>().toEqualTypeOf<
    | 'ZohoApiError' | 'ZohoInvalidRequestError' | 'ZohoOAuthError' | 'ZohoRateLimitError'
    | 'ZohoResponseError' | 'ZohoTransportError' | 'ZohoUnauthorizedError'
  >()
})
