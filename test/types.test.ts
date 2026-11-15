import { expectTypeOf, it } from 'vitest'
import type * as Effect from 'effect/Effect'
import type { ZohoRequestError } from '../src/index.ts'
import { Invoices, type ZohoBinary, type ZohoBooksClient } from '../src/books/index.ts'
import { DeliveryChallans } from '../src/books/index.ts'

it('types inputs, results, failures and requirements from Zoho’s documents', () => {
  const invoice = Invoices.getInvoice({ invoice_id: '1' })
  type Invoice = NonNullable<Effect.Success<typeof invoice>['invoice']>

  expectTypeOf<Invoice['total']>().toEqualTypeOf<string | null | undefined>()
  expectTypeOf<Invoice['is_viewed_by_client']>().toEqualTypeOf<boolean | null | undefined>()
  expectTypeOf<Effect.Error<typeof invoice>>().toEqualTypeOf<ZohoRequestError>()
  expectTypeOf<Effect.Services<typeof invoice>>().toEqualTypeOf<ZohoBooksClient>()
  expectTypeOf(Invoices.listInvoices).toBeCallableWith()
  expectTypeOf(Invoices.listInvoices).toBeCallableWith({ page: 2 })
  // @ts-expect-error a path parameter is required
  void Invoices.getInvoice()
  expectTypeOf<Parameters<typeof Invoices.getInvoice>>().toEqualTypeOf<[input: Invoices.GetInvoiceInput]>()
  expectTypeOf<Effect.Success<ReturnType<typeof DeliveryChallans.getDeliveryChallanAttachment>>>().toEqualTypeOf<ZohoBinary>()
})
