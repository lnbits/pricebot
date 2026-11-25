mod api;
mod history;
mod host;
mod input;

use serde_json::{json, Value};

wit_bindgen::generate!({ path: "../wasm/lnbits-extension.wit", world: "pricebot", generate_all });
struct Extension;

type Reply = Result<Value, String>;

fn run(input: &str, handler: fn(&Value) -> Reply) -> String {
    let request = if input.is_empty() {
        Ok(json!({}))
    } else {
        serde_json::from_str(input)
    };
    let result = match request {
        Ok(value) if value.is_object() => handler(&value),
        _ => Err("request must be a JSON object.".into()),
    };
    match result {
        Ok(data) => json!({"ok": true, "data": data}),
        Err(error) => json!({"ok": false, "error": error}),
    }
    .to_string()
}

fn scheduled(input: &str, handler: fn(&Value) -> Reply) -> String {
    let request = serde_json::from_str::<Value>(if input.is_empty() { "{}" } else { input });
    let result = match request {
        Ok(value) if value.is_object() => handler(&value),
        _ => Err("Expected an object.".into()),
    };
    match result {
        Ok(data) => data.to_string(),
        Err(error) => {
            host::log(&error, "error");
            // The scheduler marks failed invocations for retry when the guest traps.
            #[cfg(target_arch = "wasm32")]
            core::arch::wasm32::unreachable();
            #[cfg(not(target_arch = "wasm32"))]
            panic!("{error}");
        }
    }
}
impl Guest for Extension {
    fn get_state(input: String) -> String {
        run(&input, api::get_state)
    }
    fn get_history(input: String) -> String {
        run(&input, api::get_history)
    }
    fn save_alert(input: String) -> String {
        run(&input, api::save_alert)
    }
    fn delete_alert(input: String) -> String {
        run(&input, api::delete_alert)
    }
    fn save_preferences(input: String) -> String {
        run(&input, api::save_preferences)
    }
    fn collect_prices(input: String) -> String {
        scheduled(&input, api::collect_prices)
    }
    fn check_alerts(input: String) -> String {
        scheduled(&input, api::check_alerts)
    }
    fn daily_summary(input: String) -> String {
        scheduled(&input, api::daily_summary)
    }
}
export!(Extension);
