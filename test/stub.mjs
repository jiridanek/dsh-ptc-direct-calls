/** Enough of schemastery for the plugin's Config to evaluate outside a dsh install. */
const wrap = (v) => {
  const schema = {
    required: () => schema,
    default: () => schema,
    description: () => schema,
  }
  return schema
}
const z = () => wrap(null)
z.object = (o) => wrap(o)
z.array = (s) => wrap(s)
z.string = String
export default z
