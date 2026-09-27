import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useKV } from "../context/kv"
import { Currency } from "../util/currency"

export function DialogCurrencyList() {
  const kv = useKV()
  const dialog = useDialog()
  const initial = kv.get(Currency.KV, Currency.DEFAULT)

  return (
    <DialogSelect
      title="Currency"
      current={initial}
      options={Currency.ALL.map((item) => ({
        title: item.code,
        value: item.code,
        description: item.label,
        details: [`1 USD = ${item.rate} ${item.code}`],
      }))}
      onSelect={(option) => {
        kv.set(Currency.KV, option.value)
        dialog.clear()
      }}
    />
  )
}
