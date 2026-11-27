use serde::Serialize;
use windows::core::{Interface, BSTR};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationElement,
    IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, IUIAutomationValuePattern,
    UIA_CONTROLTYPE_ID, UIA_ExpandCollapsePatternId, UIA_InvokePatternId,
    UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
};

use crate::cursor::VirtualCursor;
use crate::window::{get_window_rect, hwnd_from_isize, RectInfo};

#[derive(Debug, Clone, Serialize)]
pub struct UiElementInfo {
    pub index: usize,
    pub depth: usize,
    pub name: String,
    pub control_type: String,
    pub automation_id: String,
    pub is_enabled: bool,
    pub rect: RectInfo,
    pub patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UiActionResult {
    pub ok: bool,
    pub action: String,
    pub matched_name: String,
    pub matched_automation_id: String,
    pub detail: String,
}

unsafe fn create_no_focus_uia() -> Result<IUIAutomation, String> {
    let uia2: IUIAutomation2 = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
        .map_err(|e| format!("Failed to create CUIAutomation8: {}", e))?;
    // CRITICAL: Disable AutoSetFocus so UIA actions NEVER steal foreground focus from the user!
    let _ = uia2.SetAutoSetFocus(false);
    uia2.cast::<IUIAutomation>()
        .map_err(|e| format!("Cast IUIAutomation failed: {}", e))
}

fn control_type_name(id: UIA_CONTROLTYPE_ID) -> String {
    match id.0 {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        _ => "Control",
    }
    .to_string()
}

unsafe fn detect_patterns(el: &IUIAutomationElement) -> Vec<String> {
    let mut out = Vec::new();
    if el
        .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
        .is_ok()
    {
        out.push("invoke".to_string());
    }
    if el
        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        .is_ok()
    {
        out.push("value".to_string());
    }
    if el
        .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
        .is_ok()
    {
        out.push("toggle".to_string());
    }
    if el
        .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
        .is_ok()
    {
        out.push("select".to_string());
    }
    if el
        .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
        .is_ok()
    {
        out.push("expand_collapse".to_string());
    }
    out
}

pub fn get_ui_tree(
    hwnd_val: isize,
    max_depth: usize,
    max_elements: usize,
) -> Result<Vec<UiElementInfo>, String> {
    let hwnd = hwnd_from_isize(hwnd_val)?;
    let win_rect = get_window_rect(hwnd);
    let max_depth = max_depth.clamp(1, 12);
    let max_elements = max_elements.clamp(1, 300);

    unsafe {
        let uia = create_no_focus_uia()?;
        let root = uia
            .ElementFromHandle(hwnd)
            .map_err(|e| format!("ElementFromHandle failed: {}", e))?;
        let walker = uia
            .ControlViewWalker()
            .map_err(|e| format!("ControlViewWalker failed: {}", e))?;

        let mut results = Vec::new();
        let mut stack: Vec<(IUIAutomationElement, usize)> = vec![(root, 0)];

        while let Some((el, depth)) = stack.pop() {
            if results.len() >= max_elements {
                break;
            }

            let name = el
                .CurrentName()
                .map(|b| b.to_string())
                .unwrap_or_default();
            let auto_id = el
                .CurrentAutomationId()
                .map(|b| b.to_string())
                .unwrap_or_default();
            let ctype = el
                .CurrentControlType()
                .map(control_type_name)
                .unwrap_or_else(|_| "Control".to_string());
            let is_enabled = el
                .CurrentIsEnabled()
                .map(|b| b.as_bool())
                .unwrap_or(true);
            let is_offscreen = el
                .CurrentIsOffscreen()
                .map(|b| b.as_bool())
                .unwrap_or(false);
            let rect = el.CurrentBoundingRectangle().unwrap_or_default();
            let w = (rect.right - rect.left).max(0);
            let h = (rect.bottom - rect.top).max(0);
            let patterns = detect_patterns(&el);

            let meaningful = !is_offscreen
                && w > 0
                && h > 0
                && (!patterns.is_empty() || !name.is_empty() || !auto_id.is_empty());

            if meaningful {
                let idx = results.len();
                results.push(UiElementInfo {
                    index: idx,
                    depth,
                    name,
                    control_type: ctype,
                    automation_id: auto_id,
                    is_enabled,
                    rect: RectInfo {
                        x: rect.left - win_rect.x,
                        y: rect.top - win_rect.y,
                        width: w,
                        height: h,
                    },
                    patterns,
                });
            }

            if depth < max_depth {
                // Collect children in order, then push in reverse so stack pops in visual order
                let mut children = Vec::new();
                if let Ok(mut child) = walker.GetFirstChildElement(&el) {
                    loop {
                        children.push(child.clone());
                        match walker.GetNextSiblingElement(&child) {
                            Ok(next) => child = next,
                            Err(_) => break,
                        }
                    }
                }
                for ch in children.into_iter().rev() {
                    stack.push((ch, depth + 1));
                }
            }
        }

        Ok(results)
    }
}

unsafe fn element_supports_action(el: &IUIAutomationElement, action: &str) -> bool {
    match action.to_lowercase().as_str() {
        "invoke" | "click" => el
            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            .is_ok(),
        "set_value" | "type" => el
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .is_ok(),
        "toggle" => el
            .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
            .is_ok(),
        "select" => el
            .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            .is_ok(),
        "expand" | "collapse" => el
            .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
            .is_ok(),
        _ => false,
    }
}

pub fn perform_ui_action(
    hwnd_val: isize,
    action: &str,
    name_query: Option<&str>,
    automation_id_query: Option<&str>,
    value: Option<&str>,
    cursor: &VirtualCursor,
) -> Result<UiActionResult, String> {
    let hwnd = hwnd_from_isize(hwnd_val)?;
    if name_query.is_none() && automation_id_query.is_none() {
        return Err("Either 'name' or 'automation_id' must be provided".into());
    }

    unsafe {
        let uia = create_no_focus_uia()?;
        let root = uia
            .ElementFromHandle(hwnd)
            .map_err(|e| format!("ElementFromHandle failed: {}", e))?;
        let walker = uia
            .ControlViewWalker()
            .map_err(|e| format!("ControlViewWalker failed: {}", e))?;

        let name_q = name_query.map(|s| s.to_lowercase());
        let id_q = automation_id_query.map(|s| s.to_lowercase());

        let mut stack: Vec<(IUIAutomationElement, usize)> = vec![(root, 0)];
        let mut matched: Option<(IUIAutomationElement, String, String)> = None;
        let mut fallback_matched: Option<(IUIAutomationElement, String, String)> = None;

        while let Some((el, depth)) = stack.pop() {
            let name = el
                .CurrentName()
                .map(|b| b.to_string())
                .unwrap_or_default();
            let auto_id = el
                .CurrentAutomationId()
                .map(|b| b.to_string())
                .unwrap_or_default();

            let id_ok = match &id_q {
                Some(q) => !auto_id.is_empty() && auto_id.to_lowercase() == *q,
                None => true,
            };
            let name_ok = match &name_q {
                Some(q) => !name.is_empty() && name.to_lowercase().contains(q),
                None => true,
            };

            if id_ok && name_ok {
                if element_supports_action(&el, action) {
                    matched = Some((el, name, auto_id));
                    break;
                } else if fallback_matched.is_none() {
                    fallback_matched = Some((el.clone(), name, auto_id));
                }
            }

            if depth < 10 {
                let mut children = Vec::new();
                if let Ok(mut child) = walker.GetFirstChildElement(&el) {
                    loop {
                        children.push(child.clone());
                        match walker.GetNextSiblingElement(&child) {
                            Ok(next) => child = next,
                            Err(_) => break,
                        }
                    }
                }
                for ch in children.into_iter().rev() {
                    stack.push((ch, depth + 1));
                }
            }
        }

        let (el, matched_name, matched_auto_id) = matched
            .or(fallback_matched)
            .ok_or_else(|| "No matching UIA control found in target window".to_string())?;

        // Update independent visual pointer to the control's center (never touches physical mouse)
        if let Ok(rect) = el.CurrentBoundingRectangle() {
            let cx = (rect.left + rect.right) / 2;
            let cy = (rect.top + rect.bottom) / 2;
            cursor.trigger_click(cx, cy, Some(hwnd_val), "left");
        }

        let detail = match action.to_lowercase().as_str() {
            "invoke" | "click" => {
                let pat = el
                    .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .map_err(|_| "Matched element does not support InvokePattern".to_string())?;
                pat.Invoke()
                    .map_err(|e| format!("InvokePattern::Invoke failed: {}", e))?;
                "Executed UIA InvokePattern in background (AutoSetFocus=false)".to_string()
            }
            "set_value" | "type" => {
                let val = value.ok_or("'value' parameter is required for set_value")?;
                let pat = el
                    .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .map_err(|_| "Matched element does not support ValuePattern".to_string())?;
                pat.SetValue(&BSTR::from(val))
                    .map_err(|e| format!("ValuePattern::SetValue failed: {}", e))?;
                format!("Set UIA ValuePattern to '{}' in background", val)
            }
            "toggle" => {
                let pat = el
                    .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                    .map_err(|_| "Matched element does not support TogglePattern".to_string())?;
                pat.Toggle()
                    .map_err(|e| format!("TogglePattern::Toggle failed: {}", e))?;
                "Executed UIA TogglePattern in background".to_string()
            }
            "select" => {
                let pat = el
                    .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                        UIA_SelectionItemPatternId,
                    )
                    .map_err(|_| {
                        "Matched element does not support SelectionItemPattern".to_string()
                    })?;
                pat.Select()
                    .map_err(|e| format!("SelectionItemPattern::Select failed: {}", e))?;
                "Executed UIA SelectionItemPattern::Select in background".to_string()
            }
            "expand" => {
                let pat = el
                    .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                        UIA_ExpandCollapsePatternId,
                    )
                    .map_err(|_| {
                        "Matched element does not support ExpandCollapsePattern".to_string()
                    })?;
                pat.Expand()
                    .map_err(|e| format!("ExpandCollapsePattern::Expand failed: {}", e))?;
                "Executed UIA Expand in background".to_string()
            }
            "collapse" => {
                let pat = el
                    .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                        UIA_ExpandCollapsePatternId,
                    )
                    .map_err(|_| {
                        "Matched element does not support ExpandCollapsePattern".to_string()
                    })?;
                pat.Collapse()
                    .map_err(|e| format!("ExpandCollapsePattern::Collapse failed: {}", e))?;
                "Executed UIA Collapse in background".to_string()
            }
            other => return Err(format!("Unsupported UIA action: {}", other)),
        };

        Ok(UiActionResult {
            ok: true,
            action: action.to_string(),
            matched_name,
            matched_automation_id: matched_auto_id,
            detail,
        })
    }
}
