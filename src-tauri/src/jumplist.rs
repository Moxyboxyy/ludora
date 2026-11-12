//! Rechtsklick auf das Ludora-Symbol in der Taskleiste: Aufgabe „Ludora beenden“.
//! Windows: Sprungliste (startet Ludora mit --quit; die laufende Ludora bekommt das über die
//! Einzel-Instanz und beendet sich). Linux: Eintrag „Desktop Action quit“ in der .desktop-Datei
//! (linux/ludora.desktop). macOS: Das Dock hat „Beenden“ von Haus aus.

/// Argument, mit dem ein zweiter Start die laufende Ludora beendet
pub const QUIT_ARG: &str = "--quit";

#[cfg(windows)]
pub fn install() {
    // COM im eigenen Thread (die Oberfläche läuft im Haupt-Thread)
    std::thread::spawn(|| {
        if let Err(e) = set() {
            crate::log::warn(&format!("[app] Sprungliste: {e}"));
        }
    });
}

#[cfg(not(windows))]
pub fn install() {}

#[cfg(windows)]
fn set() -> windows::core::Result<()> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink};

    let exe = std::env::current_exe().map_err(|_| windows::core::Error::from_thread())?;
    let exe = HSTRING::from(exe.as_os_str());
    let title = crate::util::t("Ludora beenden");
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        let mut slots = 0u32;
        let _removed: IObjectArray = list.BeginList(&mut slots)?;
        let tasks: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;

        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&exe)?;
        link.SetArguments(&HSTRING::from(QUIT_ARG))?;
        link.SetIconLocation(&exe, 0)?;
        link.SetDescription(&HSTRING::from(title.as_str()))?;
        let props: IPropertyStore = link.cast()?;
        props.SetValue(&PKEY_Title, &PROPVARIANT::from(title.as_str()))?;
        props.Commit()?;
        tasks.AddObject(&link)?;

        let arr: IObjectArray = tasks.cast()?;
        list.AddUserTasks(&arr)?;
        list.CommitList()?;
    }
    Ok(())
}
