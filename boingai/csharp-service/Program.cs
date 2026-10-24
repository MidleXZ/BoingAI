using System.Collections.Concurrent;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
var port = Environment.GetEnvironmentVariable("PORT") ?? "5001";
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

var app = builder.Build();

var jsonOptions = new JsonSerializerOptions
{
    WriteIndented = true,
    PropertyNameCaseInsensitive = true,
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
};
var dataDir = ResolveDataDir();
Directory.CreateDirectory(dataDir);

var conversationsFile = Path.Combine(dataDir, "conversations.json");
var memoriesFile = Path.Combine(dataDir, "memories.json");
var profileFile = Path.Combine(dataDir, "profile.json");
var sync = new object();

var store = new ConcurrentDictionary<string, Conversation>(
    Load(conversationsFile, new List<Conversation>())
        .Select(c => new KeyValuePair<string, Conversation>(c.Id, c)));

var memories = new ConcurrentDictionary<string, Memory>(
    Load(memoriesFile, new List<Memory>())
        .Select(m => new KeyValuePair<string, Memory>(m.Id, m)));

var profile = Load(profileFile, new Profile(""));

// Persist a snapshot of the conversations to disk.
void PersistConversations()
{
    Save(conversationsFile, store.Values.OrderBy(c => c.CreatedAt).ToList());
}

void PersistMemories()
{
    Save(memoriesFile, memories.Values.OrderBy(m => m.CreatedAt).ToList());
}

T Load<T>(string path, T fallback)
{
    try
    {
        if (!File.Exists(path)) return fallback;
        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<T>(json, jsonOptions) ?? fallback;
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Could not read {path}: {ex.Message}");
        return fallback;
    }
}

void Save<T>(string path, T value)
{
    try
    {
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(value, jsonOptions));
        File.Move(tmp, path, true);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Could not write {path}: {ex.Message}");
    }
}

static string ResolveDataDir()
{
    var custom = Environment.GetEnvironmentVariable("BOINGAI_DATA_DIR");
    if (!string.IsNullOrWhiteSpace(custom)) return custom;

    var baseDir = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
    if (string.IsNullOrWhiteSpace(baseDir))
        baseDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    if (string.IsNullOrWhiteSpace(baseDir))
        baseDir = AppContext.BaseDirectory;

    return Path.Combine(baseDir, "BoingAI");
}

Console.WriteLine($"BoingAI data directory: {dataDir}");

app.MapGet("/health", () => Results.Ok(new { status = "ok", service = "boingai-memory", version = "1.1.0" }));

app.MapGet("/conversations", () =>
{
    lock (sync)
    {
        return Results.Ok(store.Values.OrderBy(c => c.CreatedAt).ToList());
    }
});

app.MapPost("/conversations", () =>
{
    lock (sync)
    {
        var c = new Conversation(Guid.NewGuid().ToString("N"), DateTime.UtcNow, new List<Message>());
        store[c.Id] = c;
        PersistConversations();
        return Results.Created($"/conversations/{c.Id}", c);
    }
});

app.MapGet("/conversations/{id}", (string id) =>
{
    lock (sync)
    {
        return store.TryGetValue(id, out var c) ? Results.Ok(c) : Results.NotFound();
    }
});

app.MapPost("/conversations/{id}/messages", (string id, MessageInput input) =>
{
    lock (sync)
    {
        if (!store.TryGetValue(id, out var c)) return Results.NotFound();
        var msg = new Message(input.Role, input.Content, DateTime.UtcNow);
        c.Messages.Add(msg);
        PersistConversations();
        return Results.Ok(msg);
    }
});

app.MapDelete("/conversations/{id}", (string id) =>
{
    lock (sync)
    {
        if (!store.TryRemove(id, out _)) return Results.NotFound();
        PersistConversations();
        return Results.NoContent();
    }
});

// Memory endpoints
app.MapGet("/memories", () =>
{
    lock (sync)
    {
        return Results.Ok(memories.Values.OrderBy(m => m.CreatedAt).ToList());
    }
});

app.MapPost("/memories", (MemoryInput input) =>
{
    lock (sync)
    {
        var m = new Memory(Guid.NewGuid().ToString("N"), input.Key, input.Value, DateTime.UtcNow);
        memories[m.Id] = m;
        PersistMemories();
        return Results.Created($"/memories/{m.Id}", m);
    }
});

app.MapPut("/memories/{id}", (string id, MemoryInput input) =>
{
    lock (sync)
    {
        if (!memories.TryGetValue(id, out var existing)) return Results.NotFound();
        memories[id] = new Memory(id, input.Key, input.Value, existing.CreatedAt);
        PersistMemories();
        return Results.Ok(memories[id]);
    }
});

app.MapDelete("/memories/{id}", (string id) =>
{
    lock (sync)
    {
        if (!memories.TryRemove(id, out _)) return Results.NotFound();
        PersistMemories();
        return Results.NoContent();
    }
});

// Profile / identity
app.MapGet("/profile", () =>
{
    lock (sync)
    {
        return Results.Ok(profile);
    }
});

app.MapPut("/profile", (ProfileInput input) =>
{
    lock (sync)
    {
        profile = new Profile((input.Username ?? "").Trim());
        Save(profileFile, profile);
        return Results.Ok(profile);
    }
});

app.Run();

record Message(string Role, string Content, DateTime Timestamp);
record MessageInput(string Role, string Content);
record Conversation(string Id, DateTime CreatedAt, List<Message> Messages);
record Memory(string Id, string Key, string Value, DateTime CreatedAt);
record MemoryInput(string Key, string Value);
record Profile(string Username);
record ProfileInput(string? Username);
