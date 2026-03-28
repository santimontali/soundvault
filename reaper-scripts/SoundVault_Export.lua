-- SoundVault Export - ReaScript for REAPER
-- Exports selected items to your SoundVault library
-- Assign this script to a keyboard shortcut for fast workflow
--
-- SETUP:
-- 1. Change SOUNDVAULT_PATH below to match your SoundVault library path
-- 2. In Reaper: Actions > Show action list > Load > select this .lua file
-- 3. Right click the action > "Add shortcut" (recommended: Ctrl+Shift+V)

-----------------------------------------------------------------------
-- CONFIGURATION - Change this to your SoundVault library folder
-----------------------------------------------------------------------
local SOUNDVAULT_PATH = ""  -- leave empty to auto-detect

-- Auto-detect: looks for config file or defaults to Documents/SoundVault
function get_soundvault_path()
  if SOUNDVAULT_PATH ~= "" then return SOUNDVAULT_PATH end

  -- Try to read from SoundVault config (Electron app stores it here)
  local config_paths = {}

  local os_name = reaper.GetOS()
  if os_name:match("Win") then
    local appdata = os.getenv("APPDATA")
    if appdata then
      table.insert(config_paths, appdata .. "\\soundvault\\soundvault-config.json")
    end
  elseif os_name:match("OSX") or os_name:match("macOS") then
    local home = os.getenv("HOME")
    if home then
      table.insert(config_paths, home .. "/Library/Application Support/soundvault/soundvault-config.json")
    end
  else
    local home = os.getenv("HOME")
    if home then
      table.insert(config_paths, home .. "/.config/soundvault/soundvault-config.json")
    end
  end

  for _, cfg_path in ipairs(config_paths) do
    local f = io.open(cfg_path, "r")
    if f then
      local content = f:read("*a")
      f:close()
      local path = content:match('"libraryPath"%s*:%s*"([^"]+)"')
      if path then
        -- Unescape backslashes (JSON)
        path = path:gsub("\\\\", "\\")
        return path
      end
    end
  end

  -- Default fallback
  local home = os.getenv("HOME") or os.getenv("USERPROFILE")
  if home then
    local sep = package.config:sub(1,1)
    return home .. sep .. "Documents" .. sep .. "SoundVault"
  end

  return nil
end

-----------------------------------------------------------------------
-- Get list of existing folders in the SoundVault library
-----------------------------------------------------------------------
function get_folders(base_path)
  local folders = {}
  local sep = package.config:sub(1,1)

  -- Use reaper.EnumerateSubdirectories
  local i = 0
  while true do
    local subdir = reaper.EnumerateSubdirectories(base_path, i)
    if not subdir or subdir == "" then break end
    table.insert(folders, subdir)
    i = i + 1
  end

  table.sort(folders)
  return folders
end

-----------------------------------------------------------------------
-- Ensure directory exists
-----------------------------------------------------------------------
function ensure_dir(path)
  local sep = package.config:sub(1,1)
  -- reaper.RecursiveCreateDirectory handles this
  reaper.RecursiveCreateDirectory(path, 0)
end

-----------------------------------------------------------------------
-- Build folder selection dropdown string
-----------------------------------------------------------------------
function build_folder_dropdown(folders)
  if #folders == 0 then return "" end
  return table.concat(folders, ",")
end

-----------------------------------------------------------------------
-- Main export function
-----------------------------------------------------------------------
function export_to_soundvault()
  -- Check for selected items
  local item_count = reaper.CountSelectedMediaItems(0)
  if item_count == 0 then
    reaper.ShowMessageBox(
      "No items selected.\n\nSelect one or more items in the arrange view, then run this script again.",
      "SoundVault Export", 0)
    return
  end

  -- Get library path
  local base_path = get_soundvault_path()
  if not base_path then
    reaper.ShowMessageBox(
      "Could not find SoundVault library path.\n\nPlease set SOUNDVAULT_PATH at the top of this script.",
      "SoundVault Export", 0)
    return
  end

  ensure_dir(base_path)

  -- Get existing folders
  local folders = get_folders(base_path)
  local folder_str = build_folder_dropdown(folders)

  -- Show dialog
  local retval, user_input

  if #folders > 0 then
    -- Dialog with existing folder dropdown + new folder option
    retval, user_input = reaper.GetUserInputs(
      "SoundVault Export",
      3,
      "Existing folder (leave empty for new),New folder name (if creating new),File name prefix (optional),extrawidth=200",
      folder_str:match("^([^,]*)") .. ",,"  -- default to first folder
    )
  else
    retval, user_input = reaper.GetUserInputs(
      "SoundVault Export",
      2,
      "Folder name,File name prefix (optional),extrawidth=200",
      ","
    )
  end

  if not retval then return end  -- cancelled

  -- Parse inputs
  local parts = {}
  for part in (user_input .. ","):gmatch("(.-),") do
    table.insert(parts, part)
  end

  local target_folder, prefix

  if #folders > 0 then
    local existing = parts[1] or ""
    local new_folder = parts[2] or ""
    prefix = parts[3] or ""

    if new_folder ~= "" then
      target_folder = new_folder
    elseif existing ~= "" then
      target_folder = existing
    else
      reaper.ShowMessageBox("Please specify a folder name.", "SoundVault Export", 0)
      return
    end
  else
    target_folder = parts[1] or ""
    prefix = parts[2] or ""
    if target_folder == "" then
      reaper.ShowMessageBox("Please specify a folder name.", "SoundVault Export", 0)
      return
    end
  end

  -- Clean folder name
  target_folder = target_folder:gsub('[<>:"/\\|?*]', '_')
  prefix = prefix:gsub('[<>:"/\\|?*]', '_')

  local sep = package.config:sub(1,1)
  local export_dir = base_path .. sep .. target_folder
  ensure_dir(export_dir)

  -- Export each selected item
  reaper.Undo_BeginBlock()

  local exported = 0
  for i = 0, item_count - 1 do
    local item = reaper.GetSelectedMediaItem(0, i)
    if item then
      local take = reaper.GetActiveTake(item)
      if take then
        local source = reaper.GetMediaItemTake_Source(take)
        local source_file = reaper.GetMediaSourceFileName(source, "")

        -- Get item properties
        local item_pos = reaper.GetMediaItemInfo_Value(item, "D_POSITION")
        local item_len = reaper.GetMediaItemInfo_Value(item, "D_LENGTH")
        local take_offset = reaper.GetMediaItemTakeInfo_Value(take, "D_STARTOFFS")

        -- Generate filename
        local take_name = reaper.GetTakeName(take)
        local base_name
        if prefix ~= "" then
          base_name = prefix .. "_" .. (take_name ~= "" and take_name or string.format("item_%02d", i + 1))
        else
          base_name = take_name ~= "" and take_name or string.format("item_%02d", i + 1)
        end

        -- Clean filename
        base_name = base_name:gsub('[<>:"/\\|?*]', '_')
        local output_path = export_dir .. sep .. base_name .. ".wav"

        -- Check if file exists, add number suffix
        local counter = 1
        while reaper.file_exists(output_path) do
          output_path = export_dir .. sep .. base_name .. "_" .. string.format("%02d", counter) .. ".wav"
          counter = counter + 1
        end

        -- Use Reaper's render to bounce the item
        -- Method: Apply render using the source + time selection
        -- We'll use the glue approach for simplicity

        -- Select only this item
        reaper.Main_OnCommand(40289, 0)  -- Unselect all items
        reaper.SetMediaItemSelected(item, true)

        -- Store time selection
        local ts_start, ts_end = reaper.GetSet_LoopTimeRange(false, false, 0, 0, false)

        -- Set time selection to item bounds
        reaper.GetSet_LoopTimeRange(true, false, item_pos, item_pos + item_len, false)

        -- Set render settings for WAV
        -- We'll use the command line render approach
        -- Actually, simplest reliable method: copy source file if no processing,
        -- or use SWS if available

        -- Simple approach: use ffmpeg or just copy the rendered/glued file
        -- Most reliable: use the Reaper render API

        -- For now, use the source file approach with offset info
        -- If the item is just a clip of a source, we need to render it

        -- Use the "Render selected area of items to new file" approach
        local render_cmd = 41721 -- Render/Freeze: Render selected items to stems (with dialog)

        -- Better: Use the apply FX / bounce approach
        -- Let's use a direct WAV write approach with the item's audio

        -- Actually, the most reliable cross-platform method:
        -- 1. Select the item
        -- 2. Use "Glue items" to create a new file
        -- 3. Copy that file to our destination
        -- 4. Undo the glue

        -- Glue the item
        reaper.Main_OnCommand(41588, 0)  -- Glue items (with option to preserve)

        -- Get the new take's source file
        local glued_item = reaper.GetSelectedMediaItem(0, 0)
        if glued_item then
          local glued_take = reaper.GetActiveTake(glued_item)
          if glued_take then
            local glued_source = reaper.GetMediaItemTake_Source(glued_take, "")
            local glued_file = reaper.GetMediaSourceFileName(glued_source, "")

            if glued_file ~= "" and reaper.file_exists(glued_file) then
              -- Copy file to SoundVault
              local src = io.open(glued_file, "rb")
              if src then
                local dst = io.open(output_path, "wb")
                if dst then
                  dst:write(src:read("*a"))
                  dst:close()
                  exported = exported + 1
                end
                src:close()
              end
            end
          end
        end

        -- Undo the glue to restore original
        reaper.Main_OnCommand(40029, 0)  -- Undo

        -- Restore time selection
        reaper.GetSet_LoopTimeRange(true, false, ts_start, ts_end, false)
      end
    end
  end

  -- Restore selection
  reaper.Main_OnCommand(40289, 0)  -- Unselect all
  for i = 0, item_count - 1 do
    local item = reaper.GetSelectedMediaItem(0, i)
    -- items may have changed after undo, re-select isn't critical
  end

  reaper.Undo_EndBlock("SoundVault Export", -1)

  -- Show result
  if exported > 0 then
    reaper.ShowMessageBox(
      exported .. " sound" .. (exported > 1 and "s" or "") ..
      " exported to:\n" .. export_dir,
      "SoundVault Export", 0)
  else
    reaper.ShowMessageBox(
      "No sounds were exported. Make sure items have valid audio sources.",
      "SoundVault Export", 0)
  end
end

-- Run
export_to_soundvault()
