use serde_json::Value;
pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn num(v: &Value) -> f64 {
    v.as_f64()
        .or_else(|| v.as_str()?.parse().ok())
        .unwrap_or(f64::NAN)
}
pub fn i(v: &Value) -> i64 {
    v.as_i64().unwrap_or_else(|| num(v) as i64)
}
pub fn parsed(v: &Value) -> Result<Value, String> {
    serde_json::from_str(s(v)).map_err(|_| "Invalid stored Pricebot data.".into())
}
pub fn merge(v: &mut Value, fields: Value) {
    if let (Some(v), Value::Object(fields)) = (v.as_object_mut(), fields) {
        v.extend(fields);
    }
}
