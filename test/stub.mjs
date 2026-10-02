const wrap = (v) => ({ required: () => v, default: () => v })
const z = () => wrap(null)
z.object = (o) => wrap(o)
z.array = (s) => wrap(s)
z.string = String
export default z
